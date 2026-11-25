import { z } from "zod";

/**
 * The feedback door's contract, written down once for the tests: `POST <base>/feedback` with `x-overseer-key`, a strict
 * JSON body of at most 16 KB, and `DELETE <base>/feedback/<id>` with the key and `x-reporter-token`. An unknown key in the
 * body is a 400. Anything else under the base (the SDK's own ingest and replay) is answered 200 and counted apart.
 */
const Iso = z.string().datetime({ offset: true });
export const FeedbackBodySchema = z
  .object({
    text: z.string().min(1).max(2000),
    replayId: z.string().uuid().optional(),
    eventId: z.string().min(1).max(200).optional(),
    failed: z
      .object({
        method: z.string().regex(/^[A-Za-z]{1,10}$/),
        path: z.string().min(1).max(500),
        status: z.number().int().min(100).max(599),
        at: Iso,
      })
      .strict()
      .optional(),
    pagePath: z.string().min(1).max(500).optional(),
    environment: z.string().min(1).max(80).optional(),
    release: z.string().min(1).max(120).optional(),
    userId: z.string().min(1).max(200).optional(),
    at: Iso.optional(),
    replyWhenFixed: z.boolean().optional(),
    sdk: z.object({ name: z.string().min(1).max(60), version: z.string().min(1).max(60) }).strict().optional(),
  })
  .strict();
export type FeedbackBody = z.infer<typeof FeedbackBodySchema>;

/** The two doors of an entry: `GET <base>/feedback/<id>` and `POST <base>/feedback/<id>/answer` with `{ "better": boolean }` and nothing else. */
export const AnswerBodySchema = z.object({ better: z.boolean() }).strict();

export interface EntryState {
  state: "received" | "known" | "fixed";
  release?: string | null;
  fixedAt?: string | null;
  reply?: string | null;
  answer?: "better" | "not_better" | null;
}

export const KEY = "osk_test";
export const MAX_BODY_BYTES = 16 * 1024;

export interface DoorRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  raw: string;
  /** What the door answered. */
  status: number;
}
export interface DoorAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
export interface Door {
  /** Every request to `<base>/feedback`, in order. */
  requests: DoorRequest[];
  /** Every other request under the base (ingest, replay), in order. */
  others: DoorRequest[];
  /** The parsed bodies of the accepted POSTs. */
  accepted: FeedbackBody[];
  /** The next answer(s) to a feedback request, instead of the contract's: used once each, in order. */
  queue: DoorAnswer[];
  /** id -> reporterToken of what the door stored. */
  stored: Map<string, string>;
  /** id -> what became of it; an id that is not here is `received`. Set `answer` on a fixed one to start with an answer. */
  states: Map<string, EntryState>;
  /** An older server: both doors answer 404, as a server that has none. */
  older: boolean;
  /** The bodies of the answers the door took, in order. */
  answers: Array<{ id: string; better: boolean }>;
  handle(method: string, url: string, headers: Record<string, string>, raw: string): DoorAnswer;
}

export function createDoor(base = "/api/overseer"): Door {
  let n = 0;
  const door: Door = {
    requests: [],
    others: [],
    accepted: [],
    queue: [],
    stored: new Map(),
    states: new Map(),
    older: false,
    answers: [],
    handle(method, url, headers, raw) {
      const path = new URL(url, "http://door.invalid").pathname;
      const record = (answer: DoorAnswer, into: DoorRequest[]): DoorAnswer => {
        into.push({ method, url, headers, raw, status: answer.status });
        return answer;
      };
      if (path !== `${base}/feedback` && !path.startsWith(`${base}/feedback/`)) return record({ status: 200, body: "{}" }, door.others);
      const queued = door.queue.shift();
      if (queued) return record(queued, door.requests);
      const json = (status: number, value: unknown, extra: Record<string, string> = {}): DoorAnswer => ({
        status,
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify(value),
      });
      if (headers["x-overseer-key"] !== KEY) return record(json(401, { error: "unauthorized" }), door.requests);
      if (method === "DELETE") {
        const id = decodeURIComponent(path.slice(`${base}/feedback/`.length));
        if (door.stored.get(id) !== headers["x-reporter-token"]) return record({ status: 404 }, door.requests);
        door.stored.delete(id);
        return record({ status: 204 }, door.requests);
      }
      const entry = /^\/feedback\/([^/]+)(\/answer)?$/.exec(path.slice(base.length));
      if (entry && ((method === "GET" && !entry[2]) || (method === "POST" && entry[2]))) {
        const id = decodeURIComponent(entry[1]);
        const state = door.states.get(id) ?? { state: "received" as const };
        if (door.older || door.stored.get(id) === undefined || door.stored.get(id) !== headers["x-reporter-token"]) return record({ status: 404 }, door.requests);
        const view = (): DoorAnswer => {
          const fixed = state.state === "fixed";
          return json(200, {
            state: state.state,
            release: fixed ? (state.release ?? null) : null,
            fixedAt: fixed ? (state.fixedAt ?? null) : null,
            reply: fixed ? (state.reply ?? null) : null,
            answer: fixed ? (state.answer ?? null) : null,
          });
        };
        if (method === "GET") return record(view(), door.requests);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          return record(json(400, { error: "not json" }), door.requests);
        }
        const body = AnswerBodySchema.safeParse(value);
        if (!body.success) return record(json(400, { error: "bad body" }), door.requests);
        if (state.state !== "fixed") return record(json(409, { error: "not fixed" }), door.requests);
        state.answer = body.data.better ? "better" : "not_better";
        door.states.set(id, state);
        door.answers.push({ id, better: body.data.better });
        return record(view(), door.requests);
      }
      if (method !== "POST" || path !== `${base}/feedback`) return record({ status: 404 }, door.requests);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return record(json(413, { error: "too large" }), door.requests);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return record(json(400, { error: "not json" }), door.requests);
      }
      const parsed = FeedbackBodySchema.safeParse(value);
      if (!parsed.success) return record(json(400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }), door.requests);
      const id = `fb_${++n}`;
      const reporterToken = `rt_${n}_secret`;
      door.stored.set(id, reporterToken);
      door.accepted.push(parsed.data);
      return record(json(201, { id, reporterToken, known: false }), door.requests);
    },
  };
  return door;
}

/** A `fetch` that answers from the door; `calls` keeps every call's url and init. */
export function doorFetch(door: Door): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const answer = door.handle(init.method ?? "GET", url, headers, typeof init.body === "string" ? init.body : "");
    return new Response(answer.status === 204 ? null : (answer.body ?? ""), { status: answer.status, headers: answer.headers });
  };
  return { fetch: fn as typeof fetch, calls };
}
