import { redactSecrets } from "../logs/redact";
import { isSecretKey } from "./secret-keys";
import type { Breadcrumb, OverseerEvent } from "./index";

/**
 * The text of an error event, scrubbed before `beforeSend` and before the fingerprint is computed (so a group is made of
 * the scrubbed text). {@link sanitizeExtra} judges the keys of what an app attaches; this judges the words: the message,
 * the exception value, every breadcrumb message, every string inside `extra` and breadcrumb `data`, and tag values lose
 * what {@link redactSecrets} finds (cookies, JWTs, bearer tokens, `token=...` pairs, prefixed keys, query strings). A tag
 * whose key names a secret is dropped. Emails and IP addresses are left as they are.
 */

/** The depth `sanitizeExtra` allows. */
const MAX_DEPTH = 6;

function leaf(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  // Only plain objects and arrays hold what an app attached; a Date, a Map or a class instance is kept as it is.
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!isArray && proto !== Object.prototype && proto !== null) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (isArray) return (value as unknown[]).map((v) => leaf(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = leaf(v, depth + 1, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

function record(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = leaf(v, 1, new WeakSet<object>([data]));
  return out;
}

/** The tags without a secret key, their values scrubbed. A copy. */
export function scrubTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (isSecretKey(k)) continue;
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...b };
  if (typeof b.message === "string") out.message = redactSecrets(b.message);
  if (b.data) out.data = record(b.data);
  return out;
}

/** A scrubbed copy of an error or message event; every other type is returned as it is. The argument is never changed. */
export function scrubEvent(event: OverseerEvent): OverseerEvent {
  if (event.type !== "error" && event.type !== "message") return event;
  const out: OverseerEvent = { ...event };
  if (typeof event.message === "string") out.message = redactSecrets(event.message);
  if (event.exception) {
    out.exception = { ...event.exception };
    if (typeof event.exception.value === "string") out.exception.value = redactSecrets(event.exception.value);
    if (Array.isArray(event.exception.causes)) {
      out.exception.causes = event.exception.causes.map((c) => (typeof c?.value === "string" ? { ...c, value: redactSecrets(c.value) } : c));
    }
  }
  if (event.tags) out.tags = scrubTags(event.tags);
  if (event.extra) out.extra = record(event.extra);
  if (event.breadcrumbs) out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return out;
}
