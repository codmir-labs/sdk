/**
 * @codmir/sdk/feedback - what an app's visitors say, sent with the session it is about.
 *
 * ```ts
 * import { sendFeedback } from "@codmir/sdk/feedback";
 *
 * const result = await sendFeedback("the save button does nothing");
 * ```
 *
 * Browser-safe: no Node import; importing this file does nothing. It reads the client `init()` made through the
 * global slot the overseer entry fills, so it never pulls the client into its own bundle.
 */

import type { FeedbackContext } from "../overseer/index";
import { feedbackUrl } from "../endpoints";
import { isSdkRequest, resolveUrl, shouldPropagate } from "../tracing/url-match";
import { SDK_INFO } from "../version";

export interface FeedbackStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface FeedbackInput {
  /** What the person said: 1 to 2000 characters. Never cut for you: longer is refused as `too_long`. */
  text: string;
  /** A wish only: the server keeps it; read what became of the entry with `feedbackStatus`. */
  replyWhenFixed?: boolean;
  /** The session replay it happened in, when the SDK does not record it here (a server passes the page's). `false`: none. */
  replayId?: string | false;
  /** The error this is about, when the SDK's last error of the last 10 minutes is not it. `false`: none. */
  eventId?: string | false;
  /** The request that failed, when the SDK's last failed request of the last 5 minutes is not it. `false`: none. */
  failedRequest?: { method: string; path: string; status: number; at?: string } | false;
  /** The page, as a path. Default `location.pathname`. `false`: none. */
  pagePath?: string | false;
  /** Your id for the person, as in `setUser`; the server keeps only a hash. Default `user.id`. `false`: none. */
  userId?: string | false;
  /** Where the receipt (id and token, never the text) is kept. Default `localStorage`, else memory; on a server nowhere. `false`: nowhere. */
  storage?: FeedbackStorage | false;
  /** 1000 to 60000, default 10000. */
  timeoutMs?: number;
}

export type FeedbackFailure =
  | "not_configured"
  | "empty"
  | "too_long"
  | "unauthorized"
  | "payment_required"
  | "rate_limited"
  | "refused"
  | "unavailable";

export type FeedbackResult =
  | { ok: true; id: string; reporterToken: string; known: boolean }
  | { ok: false; reason: FeedbackFailure; status?: number; retryAfterMs?: number };

export type FeedbackDeleteResult = { ok: true } | { ok: false; reason: "not_configured" | "not_found" | "unavailable" };

/** What became of an entry. `release`, `fixedAt`, `reply` and `answer` are null unless `state` is `fixed`. */
export interface FeedbackStatus {
  state: "received" | "known" | "fixed";
  release: string | null;
  fixedAt: string | null;
  reply: string | null;
  answer: "better" | "not_better" | null;
}

export type FeedbackStatusResult =
  | ({ ok: true } & FeedbackStatus)
  | { ok: false; reason: "not_configured" | "not_found" | "unauthorized" | "rate_limited" | "unavailable"; status?: number; retryAfterMs?: number };

export type FeedbackAnswerResult = FeedbackStatusResult | { ok: false; reason: "not_fixed" | "refused"; status?: number };

interface Receipt {
  id: string;
  token: string;
  at: string;
}
type Answer = { status: number; retry: string | null; body: string; big?: true } | null;

const STORAGE_KEY = "codmir:feedback";
const CLIENT_SLOT = Symbol.for("codmir.overseer.client");
const METHOD = /^[A-Za-z]{1,10}$/;
const UUID = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_BODY = 16000;
// a reply of 1000 control characters is 6000 in JSON
const MAX_ANSWER = 8192;
const KEPT = 20;
const DAY = 86400000;

/**
 * One visitor per client: a page, or a React Native app. On a server all visitors share the client, so its last error, its
 * last failed request, its user, a request in flight and a kept receipt would be somebody else's.
 */
const oneVisitor = (): boolean => {
  const g = globalThis as { document?: unknown; navigator?: { product?: unknown } };
  return g.document !== undefined || g.navigator?.product === "ReactNative";
};

const inflight = new Map<string, Promise<FeedbackResult>>();
const reading = new Map<string, Promise<FeedbackStatusResult>>();
// the last answer sent for an id: the next one waits for it
const answering = new Map<string, Promise<unknown>>();
// what `local` wrote last: the one key it ever holds
let mirror: string | null = null;
let broken = false;
// The default storage: localStorage, mirrored in memory so that a missing, refusing or full localStorage still holds the receipts.
const local = {
  getItem(k: string): string | null {
    try {
      if (!broken) return (globalThis as { localStorage: FeedbackStorage }).localStorage.getItem(k) as string | null;
    } catch {
      broken = true;
    }
    return mirror;
  },
  setItem(k: string, v: string): void {
    mirror = v;
    try {
      if (!broken) (globalThis as { localStorage: FeedbackStorage }).localStorage.setItem(k, v);
    } catch {
      broken = true;
    }
  },
};

const fail = <R extends string>(reason: R, extra?: { status?: number; retryAfterMs?: number }) => ({ ok: false as const, reason, ...extra });
const get = (o: unknown, k: string): unknown => {
  try {
    return o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  } catch {
    return undefined;
  }
};
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : undefined);
const iso = (v: unknown): string | undefined => {
  const t = typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : 0;
  return t > 0 ? new Date(t).toISOString() : undefined;
};
/** The pathname of a path or URL: never a query, a fragment or an origin. */
const pathOf = (v: unknown): string | undefined => {
  try {
    return typeof v === "string" ? str(new URL(v, "http://a").pathname, 500) : undefined;
  } catch {
    return undefined;
  }
};
const isStatus = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= 599;

function contextOf(): FeedbackContext | null {
  try {
    const ctx = ((globalThis as Record<symbol, unknown>)[CLIENT_SLOT] as { feedbackContext(): FeedbackContext }).feedbackContext();
    return ctx.enabled && ctx.dsn && ctx.key ? ctx : null;
  } catch {
    return null; // no client, an older one, or one that fails
  }
}

/** The newest request breadcrumb of the last 5 minutes that failed with an answer, to this page or a propagation target. */
function lastFailed(ctx: FeedbackContext, now: number): unknown {
  // our own breadcrumbs: plain objects the client built, so no getter can throw here
  for (const crumb of [...ctx.breadcrumbs].reverse()) {
    const data: { url?: unknown; status?: unknown; method?: unknown } = crumb.data ?? {};
    const at = iso(crumb.timestamp);
    const url = typeof data.url === "string" ? resolveUrl(data.url) : null;
    if (!/^(fetch|xhr)$/.test(crumb.category as string) || !at || !url || now - Date.parse(at) > 300000 || !isStatus(data.status, 400)) continue;
    if (!shouldPropagate(url, ctx.tracePropagationTargets)) continue;
    // the SDK's own requests (ingest, replay, feedback) are not the app's
    if (isSdkRequest(url, ctx.dsn)) continue;
    return { method: data.method, path: url.pathname, status: data.status, at };
  }
  return undefined;
}

/** A failed request as the door takes it, or nothing when a part does not fit. */
function failedOf(v: unknown, at: string): unknown {
  const method = get(v, "method");
  const path = pathOf(get(v, "path"));
  const code = get(v, "status");
  const when = iso(get(v, "at") ?? at);
  return typeof method === "string" && METHOD.test(method) && path && isStatus(code, 100) && when ? { method: method.toUpperCase(), path, status: code, at: when } : undefined;
}

/** The body, from a fixed list of keys: nothing but what is named here can leave. A value that does not fit is left out. */
function bodyOf(ctx: FeedbackContext, text: string, input: unknown, now: number): string {
  const at = new Date(now).toISOString();
  const own = oneVisitor();
  // the caller's value, else the SDK's own (`auto`, never on a server); `false` switches it off
  const pick = (key: string, auto: () => unknown, norm: (v: unknown) => unknown): unknown => {
    const v = get(input, key);
    return v === false ? undefined : norm(v !== undefined ? v : own ? auto() : undefined);
  };
  const replyWhenFixed = get(input, "replyWhenFixed");
  // undefined values are not serialized, so a key is there only when its value fits
  const json = JSON.stringify({
    text,
    replyWhenFixed: typeof replyWhenFixed === "boolean" ? replyWhenFixed : undefined,
    replayId: pick("replayId", () => ctx.replayId(), (v) => (typeof v === "string" && UUID.test(v) ? v : undefined)),
    eventId: pick("eventId", () => (ctx.lastError && now - ctx.lastError.at <= 600000 ? ctx.lastError.id : undefined), (v) => str(v, 200)),
    failed: pick("failedRequest", () => lastFailed(ctx, now), (v) => failedOf(v, at)),
    pagePath: pick("pagePath", () => (globalThis as { location?: { pathname?: string } }).location?.pathname, pathOf),
    environment: str(ctx.environment, 80),
    release: ctx.release === "unknown" ? undefined : str(ctx.release, 120),
    userId: pick("userId", () => ctx.userId, (v) => str(v, 200)),
    at,
    sdk: SDK_INFO,
  });
  // the UTF-8 length: each %XX of the encoded text is one byte. Only control characters in every field can pass 16 KB:
  // then the words go alone.
  return encodeURI(json).replace(/%../g, "x").length > MAX_BODY ? JSON.stringify({ text, at, sdk: SDK_INFO }) : json;
}

function retryMs(header: string | null): number | undefined {
  const h = header?.trim() ?? "";
  const ms = /^\d{1,9}$/.test(h)
    ? +h * 1000
    : /^\w{3}, .* GMT$/.test(h)
      ? Date.parse(h) - Date.now()
      : NaN;
  return ms >= 0 ? Math.min(ms, DAY) : undefined;
}

/**
 * One request that never throws: the status and the (short) body, or null for a network error, a timeout or an answer that is
 * too large (with `keepBig`, that one keeps its status, marked `big`, and no body).
 */
function call(url: string, init: RequestInit, ms: number, keepBig = false): Promise<Answer> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work: Promise<Answer> = (async () => {
    // No cookies, no keepalive.
    const res = await fetch(url, { ...init, signal: ctrl.signal, credentials: "omit" });
    const body = await res.text();
    const status = res.status;
    if (body.length <= MAX_ANSWER) return { status, retry: res.headers.get("retry-after"), body };
    return keepBig ? { status, retry: null, body: "", big: true as const } : null;
  })().catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function run(ctx: FeedbackContext, text: string, input: unknown): Promise<FeedbackResult> {
  const given = get(input, "timeoutMs");
  const ms = Number.isFinite(given) ? Math.min(Math.max(given as number, 1000), 60000) : 10000;
  const answer = await call(
    feedbackUrl(ctx.dsn),
    { method: "POST", headers: { "Content-Type": "application/json", "x-overseer-key": ctx.key }, body: bodyOf(ctx, text, input, Date.now()) },
    ms,
  );
  if (!answer) return fail("unavailable");
  const { status } = answer;
  if (status >= 200 && status < 300) {
    let json: { id?: unknown; reporterToken?: unknown; known?: unknown } | null = null;
    try {
      json = JSON.parse(answer.body);
    } catch {
      // not JSON: the check below says so
    }
    const id = str(json?.id, 200);
    const token = str(json?.reporterToken, 1000);
    if (!id || !token) return fail("unavailable", { status });
    const given = get(input, "storage") as FeedbackStorage | false | undefined;
    const storage = given ?? (oneVisitor() && local);
    if (storage) await save(ctx.key, storage, (kept) => [{ id, token, at: new Date().toISOString() }, ...kept]);
    return { ok: true, id, reporterToken: token, known: json?.known === true };
  }
  const retryAfterMs = retryMs(answer.retry);
  const extra = { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  const named: Record<number, FeedbackFailure> = { 401: "unauthorized", 402: "payment_required", 429: "rate_limited" };
  return fail(named[status] ?? (status >= 400 && status < 500 && status !== 404 ? "refused" : "unavailable"), extra);
}

/**
 * Sends what a visitor said, with the replay, the error and the failed request of their session. Never throws and never
 * rejects; read `ok`. Two calls with the same text while the first is in flight are one request and one result. On a
 * server only what you pass is sent: the client there is everybody's.
 */
export async function sendFeedback(input: string | FeedbackInput): Promise<FeedbackResult> {
  const ctx = contextOf();
  if (!ctx) return fail("not_configured");
  const raw = typeof input === "string" ? input : get(input, "text");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_TEXT) return fail(text ? "too_long" : "empty");
  const send = () => run(ctx, text, input).catch(() => fail("unavailable"));
  if (!oneVisitor()) return send();
  let result = inflight.get(text);
  if (!result) {
    result = send().finally(() => inflight.delete(text));
    inflight.set(text, result);
  }
  return result;
}

/** Takes a receipt back: the stored token unless `reporterToken` is given. 204 and 404 both forget what is stored. */
export async function deleteFeedback(id: string, reporterToken?: string): Promise<FeedbackDeleteResult> {
  const ctx = contextOf();
  if (!ctx) return fail("not_configured");
  const own = oneVisitor();
  const token = reporterToken ?? (own ? receiptsOf(local.getItem(STORAGE_KEY), ctx.key).find((r) => r.id === id)?.token : undefined);
  if (!str(id, 200) || !str(token, 1000)) return fail("not_found");
  const answer = await call(
    feedbackUrl(ctx.dsn, id),
    { method: "DELETE", headers: { "x-overseer-key": ctx.key, "x-reporter-token": token as string } },
    10000,
  );
  if (!answer || (answer.status !== 204 && answer.status !== 404)) return fail("unavailable");
  if (own) await save(ctx.key, local, (kept) => kept.filter((r) => r.id !== id));
  return answer.status === 204 ? { ok: true } : fail("not_found");
}

const STATES = ["received", "known", "fixed"];

/** The door's answer to the status or the answer call, field by field: a part that does not fit is null, and all four are null unless fixed. */
function statusFrom(body: string): FeedbackStatus | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const state = get(json, "state");
  if (typeof state !== "string" || !STATES.includes(state)) return undefined;
  if (state !== "fixed") return { state: state as FeedbackStatus["state"], release: null, fixedAt: null, reply: null, answer: null };
  const fixedAt = get(json, "fixedAt");
  const answer = get(json, "answer");
  return {
    state: "fixed",
    release: str(get(json, "release"), 200) ?? null,
    fixedAt: typeof fixedAt === "string" ? (iso(fixedAt) ?? null) : null,
    reply: str(get(json, "reply"), 1000) ?? null,
    answer: answer === "better" || answer === "not_better" ? answer : null,
  };
}

/** One of the two doors of an entry. Never changes the receipts: a 404 may be an older server. */
async function entryCall(ctx: FeedbackContext, id: string, token: string, send: { method: string; suffix: string; body?: string }): Promise<FeedbackAnswerResult> {
  const headers: Record<string, string> = { "x-overseer-key": ctx.key, "x-reporter-token": token };
  if (send.body !== undefined) headers["Content-Type"] = "application/json";
  const answer = await call(
    feedbackUrl(ctx.dsn, id, send.suffix),
    { method: send.method, headers, body: send.body, ...(send.method === "GET" ? { cache: "no-store" as const } : {}) },
    10000,
    true,
  );
  if (!answer) return fail("unavailable");
  const { status } = answer;
  if (answer.big) return fail("unavailable", { status });
  if (status >= 200 && status < 300) {
    const found = statusFrom(answer.body);
    return found ? { ok: true, ...found } : fail("unavailable", { status });
  }
  const retryAfterMs = retryMs(answer.retry);
  if (status === 401) return fail("unauthorized", { status });
  if (status === 404) return fail("not_found", { status });
  if (status === 429) return fail("rate_limited", { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  if (send.method === "POST" && status === 409) return fail("not_fixed", { status });
  if (send.method === "POST" && status >= 400 && status < 500) return fail("refused", { status });
  return fail("unavailable", { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}

/** The token to use: the one given, else (in a page only) the one stored. Nothing is sent without an id and a token. */
function tokenFor(ctx: FeedbackContext, id: string, given: unknown): string | undefined {
  const token = given ?? (oneVisitor() ? receiptsOf(local.getItem(STORAGE_KEY), ctx.key).find((r) => r.id === id)?.token : undefined);
  return str(id, 200) && str(token, 1000) ? (token as string) : undefined;
}

/**
 * What became of an entry: `received`, `known` or `fixed` (with the release, the time and the reply). Never throws, never
 * rejects, never changes the stored receipts (a `not_found` may be an older server). The token is the stored one unless
 * given. On a page, two calls for the same entry while the first is in flight are one request. Ask once per page view.
 */
export async function feedbackStatus(id: string, reporterToken?: string): Promise<FeedbackStatusResult> {
  try {
    const ctx = contextOf();
    if (!ctx) return fail("not_configured");
    const token = tokenFor(ctx, id, reporterToken);
    if (!token) return fail("not_found");
    const run = () => entryCall(ctx, id, token, { method: "GET", suffix: "" }).catch(() => fail("unavailable")) as Promise<FeedbackStatusResult>;
    if (!oneVisitor()) return await run();
    const k = JSON.stringify([ctx.key, id, token]);
    let result = reading.get(k);
    if (!result) {
      result = run().finally(() => reading.delete(k));
      reading.set(k, result);
    }
    return await result;
  } catch {
    return fail("unavailable");
  }
}

/**
 * Tells whether a fix helped. Never throws, never rejects, never changes the receipts. `not_fixed` when the entry is not
 * fixed (yet, or any more). A second answer replaces the first; answers are never merged and go out in order, each after
 * the one before it.
 */
export async function answerFeedback(id: string, better: boolean, reporterToken?: string): Promise<FeedbackAnswerResult> {
  try {
    if (typeof better !== "boolean") return fail("refused");
    const ctx = contextOf();
    if (!ctx) return fail("not_configured");
    const token = tokenFor(ctx, id, reporterToken);
    if (!token) return fail("not_found");
    const k = JSON.stringify([ctx.key, id]);
    const before = answering.get(k);
    const mine = (before ?? Promise.resolve()).then(() =>
      entryCall(ctx, id, token, { method: "POST", suffix: "/answer", body: JSON.stringify({ better }) }).catch(() => fail("unavailable") as FeedbackAnswerResult),
    );
    const done = mine.finally(() => {
      if (answering.get(k) === done) answering.delete(k);
    });
    answering.set(k, done);
    return await mine;
  } catch {
    return fail("unavailable");
  }
}

/** What this visitor sent from this device, newest first. Only the id and the time: the words are never kept. */
export function listFeedback(): Array<{ id: string; at: string }> {
  const ctx = contextOf();
  return ctx && oneVisitor() ? receiptsOf(local.getItem(STORAGE_KEY), ctx.key).map(({ id, at }) => ({ id, at })) : [];
}

// --- the receipts: `{ [project key]: [{ id, token, at }] }` under one key ---

function parse(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(raw as string);
    return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  } catch {
    return {}; // junk: start over
  }
}

/** The receipts of one project key, field by field: what is read back may have been written by any script on the page. */
function receiptsOf(raw: unknown, key: string): Receipt[] {
  const list = parse(raw)[key];
  const out: Receipt[] = [];
  // parsed JSON: plain values, no getter to throw
  for (const item of Array.isArray(list) ? (list as Array<{ id?: unknown; token?: unknown; at?: unknown } | null>) : []) {
    const id = str(item?.id, 200);
    const token = str(item?.token, 1000);
    const at = iso(item?.at);
    if (!id || !token || !at || Date.now() - Date.parse(at) > 365 * DAY) continue;
    out.push({ id, token, at });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, KEPT);
}

/** Writes this project's receipts, the other projects' as they were. A storage that refuses keeps nothing. */
async function save(key: string, store: Pick<FeedbackStorage, "getItem" | "setItem">, change: (kept: Receipt[]) => Receipt[]): Promise<void> {
  try {
    const raw = await store.getItem(STORAGE_KEY);
    const all = parse(raw);
    all[key] = change(receiptsOf(raw, key)).slice(0, KEPT);
    await store.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // the receipt is a courtesy: a storage that fails never fails the feedback
  }
}
