/**
 * The conversation id and the session id belong to the request on a server: `setConversationId` and `setSessionId`
 * inside a request write that request's scope, so two overlapping requests never see each other's on an error. A batch
 * carries the client's own session id only, never a request's. Outside any request they are the client's, as in a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNodeTracingContext, traceServerRequest } from "../../tracing/server";
import * as overseer from "../index";

type Sent = {
  type: string;
  message?: string;
  extra?: { conversationId?: string | null; sessionId?: string | null };
  contexts?: { conversation?: { id: string }; session?: { id: string } };
};
type Batch = { sessionId?: string; events: Array<{ type: string; event?: Sent }> };
let batches: Batch[];

const sentEvents = (): Sent[] =>
  batches.flatMap((b) => b.events.map((w) => (w.event ?? w) as Sent)).filter((e) => e.type !== "transaction");
const eventOf = (message: string): Sent => {
  const events = sentEvents().filter((e) => e.message === message);
  expect(events, message).toHaveLength(1);
  return events[0];
};

beforeEach(() => {
  batches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ingest")) batches.push(JSON.parse(String(init?.body)) as Batch);
      return new Response("{}", { status: 200 });
    }),
  );
  installNodeTracingContext();
  overseer.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test" });
});
afterEach(() => {
  overseer.close();
  vi.unstubAllGlobals();
});

class Barrier {
  private arrived = 0;
  private release!: () => void;
  private readonly open = new Promise<void>((resolve) => (this.release = resolve));
  constructor(private readonly n: number) {}
  wait(): Promise<void> {
    if (++this.arrived === this.n) this.release();
    return this.open;
  }
}

const serve = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  traceServerRequest({ method: "GET", route: `/t/${name}`, url: `https://app.test/t/${name}` }, fn);

describe("conversation and session ids on a server", () => {
  it("two overlapping requests each carry their own ids", async () => {
    const setA = new Barrier(1);
    const setB = new Barrier(1);
    const request = async (id: "a" | "b"): Promise<void> => {
      if (id === "b") await setA.wait();
      overseer.setConversationId(`conv-${id}`);
      overseer.setSessionId(`sess-${id}`);
      if (id === "a") {
        setA.wait();
        // B sets its ids after A and before A captures.
        await setB.wait();
      } else {
        setB.wait();
      }
      expect(overseer.getConversationId()).toBe(`conv-${id}`);
      expect(overseer.getSessionId()).toBe(`sess-${id}`);
      overseer.captureException(new Error(`${id}:error`));
    };
    await Promise.all([serve("a", () => request("a")), serve("b", () => request("b"))]);
    await overseer.flush();
    for (const id of ["a", "b"]) {
      const event = eventOf(`${id}:error`);
      expect(event.extra).toMatchObject({ conversationId: `conv-${id}`, sessionId: `sess-${id}` });
      expect(event.contexts?.conversation).toEqual({ id: `conv-${id}` });
      expect(event.contexts?.session).toEqual({ id: `sess-${id}` });
    }
  });

  it("the batch carries no request's session id", async () => {
    await serve("a", async () => {
      overseer.setSessionId("sess-a");
      overseer.captureException(new Error("a:error"));
    });
    await overseer.flush();
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) expect(batch.sessionId ?? null).toBeNull();
    expect(eventOf("a:error").contexts?.session).toEqual({ id: "sess-a" });
    // Nothing leaked into the client: outside the request there is no id.
    expect(overseer.getSessionId()).toBeNull();
    expect(overseer.getConversationId()).toBeNull();
  });

  it("the batch carries the process-wide session id set outside any request, and a request still has its own", async () => {
    overseer.setSessionId("sess-process");
    overseer.setConversationId("conv-process");
    await serve("a", async () => {
      overseer.setSessionId("sess-a");
      overseer.captureException(new Error("a:error"));
    });
    await serve("b", async () => {
      overseer.captureException(new Error("b:error"));
    });
    await overseer.flush();
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) expect(batch.sessionId).toBe("sess-process");
    expect(eventOf("a:error").contexts).toMatchObject({ session: { id: "sess-a" }, conversation: { id: "conv-process" } });
    expect(eventOf("b:error").contexts).toMatchObject({ session: { id: "sess-process" }, conversation: { id: "conv-process" } });
  });
});

describe("outside a request", () => {
  it("the ids are the client's: on the event and on the batch", async () => {
    overseer.setConversationId("conv-x");
    overseer.setSessionId("sess-x");
    overseer.captureException(new Error("x:error"));
    await overseer.flush();
    const event = eventOf("x:error");
    expect(event.extra).toMatchObject({ conversationId: "conv-x", sessionId: "sess-x" });
    expect(event.contexts).toMatchObject({ conversation: { id: "conv-x" }, session: { id: "sess-x" } });
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) expect(batch.sessionId).toBe("sess-x");
  });
});
