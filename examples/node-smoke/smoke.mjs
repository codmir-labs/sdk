/**
 * Node smoke for @codmir/sdk (CSL-5628): sends ONE error, ONE transaction with a child span and ONE replay segment
 * to a Codmir project and checks that each was accepted.
 *
 *   CODMIR_DSN=<base> CODMIR_KEY=<project key> npm run smoke
 *
 * CODMIR_DSN is the same base the browser snippet uses (the SDK adds `/ingest` and `/replay`); CODMIR_ENDPOINT is
 * an alias. CODMIR_KEY (or CODMIR_CLIENT_KEY) is the project key from Settings > Codmir SDK. The key is never
 * printed except its last 4 characters.
 *
 * The error and the transaction go through the SDK's public API (init, setTag, captureException, startTransaction,
 * flush). The replay segment is built with the SDK's own `buildSegmentBody`/`replayEndpoint` from a small rrweb
 * fixture and POSTed with the same `x-overseer-key` header: recording needs a browser, so the recorder path is a
 * QA item, not part of this smoke. Each item's HTTP status and the server's accepted/dropped answer are read by
 * tapping `fetch` for the length of the run.
 *
 * Exit code: 0 when all three are accepted, 1 otherwise (non-2xx, dropped by the server, or never sent).
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SMOKE_ERROR_MESSAGE = "codmir smoke: deliberate error";

/** One full snapshot (type 2) and one incremental event (type 3), as rrweb emits them. Not a real page. */
export function fixtureEvents(now = Date.now()) {
  return [
    {
      type: 2,
      timestamp: now - 1000,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            { type: 2, id: 2, tagName: "html", attributes: {}, childNodes: [{ type: 2, id: 3, tagName: "body", attributes: {}, childNodes: [] }] },
          ],
        },
        initialOffset: { top: 0, left: 0 },
      },
    },
    { type: 3, timestamp: now - 500, data: { source: 3, id: 3, x: 0, y: 120 } },
  ];
}

const mask = (key) => `****${String(key).slice(-4)}`;

/** Runs the smoke against `dsn`. `sdk` is `{ overseer, tracing, replay }`, the SDK's public entries. Never throws for a failed item. */
export async function runSmoke({ dsn, key, sdk, runId = randomUUID().slice(0, 8), log = console.log }) {
  const { overseer, tracing, replay } = sdk;
  const base = dsn.replace(/\/+$/, "");
  const seen = []; // { url, status, requestBody, responseBody }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const res = await realFetch(input, init);
    if (url.startsWith(base)) {
      let responseBody = null;
      try {
        responseBody = await res.clone().json();
      } catch {
        // not JSON
      }
      let requestBody = null;
      try {
        requestBody = JSON.parse(String(init?.body));
      } catch {
        // not JSON
      }
      seen.push({ url, status: res.status, requestBody, responseBody });
    }
    return res;
  };

  const items = [];
  try {
    overseer.init({ dsn: base, clientKey: key, environment: "smoke", release: "smoke", service: "node-smoke", tracesSampleRate: 1 });

    const replayId = randomUUID();
    overseer.setTag("smoke", runId);
    overseer.setTag("replay_id", replayId); // what the SDK recorder sets while it records; links the error to the replay
    const errorId = overseer.captureException(new Error(SMOKE_ERROR_MESSAGE));

    const tx = tracing.startTransaction({ op: "smoke", name: "codmir smoke transaction", tags: { smoke: runId } });
    const child = tx.startChild({ op: "smoke.step", name: "codmir smoke child span" });
    child.end();
    tx.end();
    const traceId = tx.traceId;

    await overseer.flush();

    const events = fixtureEvents();
    const segment = replay.buildSegmentBody(
      { environment: "smoke", release: "smoke" },
      { replayId, sequenceNumber: 0, events, errorIds: [errorId] },
    );
    let replayRes = null;
    try {
      const res = await realFetch(replay.replayEndpoint(base), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-overseer-key": key },
        body: JSON.stringify(segment),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        // not JSON
      }
      replayRes = { status: res.status, body };
    } catch (err) {
      replayRes = { status: 0, body: { error: String(err?.message ?? err) } };
    }

    // The ingest answer lists dropped events by their index in that request's `events`.
    const ingestFor = (match) => {
      for (const r of [...seen].reverse()) {
        const evs = r.requestBody?.events;
        const index = Array.isArray(evs) ? evs.findIndex(match) : -1;
        if (index >= 0) return { ...r, index };
      }
      return null;
    };
    const ingestItem = (kind, id, hit) => {
      if (!hit) return { kind, status: 0, id, accepted: false, answer: "never sent" };
      const dropped = (hit.responseBody?.droppedEvents ?? []).find((d) => d.index === hit.index);
      const ok = hit.status >= 200 && hit.status < 300 && !dropped;
      const answer = dropped ? `dropped (${dropped.reason ?? "unknown"})` : ok ? "accepted" : `rejected${hit.responseBody?.error ? `: ${hit.responseBody.error}` : ""}`;
      return { kind, status: hit.status, id, accepted: ok, answer };
    };
    items.push(ingestItem("error", errorId, ingestFor((e) => e?.type === "error" && e.event?.id === errorId)));
    items.push(ingestItem("trace", traceId, ingestFor((e) => e?.type === "transaction" && e.trace_id === traceId)));
    const replayStored = replayRes.status >= 200 && replayRes.status < 300 && replayRes.body?.stored !== false;
    items.push({
      kind: "replay",
      status: replayRes.status,
      id: replayId,
      accepted: replayStored,
      answer: replayStored ? "accepted" : replayRes.body?.stored === false ? `not stored (${replayRes.body.reason ?? "unknown"})` : `rejected${replayRes.body?.error ? `: ${replayRes.body.error}` : ""}`,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  log(`codmir smoke run ${runId} -> ${base} (key ${mask(key)})`);
  for (const i of items) log(`${i.kind.padEnd(6)} HTTP ${i.status} id=${i.id} ${i.answer}`);
  return { runId, items, ok: items.length === 3 && items.every((i) => i.accepted) };
}

/** The CLI: reads env, returns the exit code. */
export async function main(env = process.env, sdk, log = console.log) {
  const dsn = env.CODMIR_DSN || env.CODMIR_ENDPOINT || "";
  const key = env.CODMIR_KEY || env.CODMIR_CLIENT_KEY || "";
  if (!dsn || !key) {
    console.error("Set CODMIR_DSN (or CODMIR_ENDPOINT) and CODMIR_KEY. See examples/node-smoke/README.md.");
    return 1;
  }
  const modules =
    sdk ??
    {
      overseer: await import("@codmir/sdk/overseer"),
      tracing: await import("@codmir/sdk/tracing"),
      replay: await import("@codmir/sdk/replay"),
    };
  const { ok } = await runSmoke({ dsn, key, sdk: modules, log });
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
