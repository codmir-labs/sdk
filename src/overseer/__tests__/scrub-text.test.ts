/**
 * Secrets inside an error's text are scrubbed before sending: the message, the exception value, `captureMessage` text,
 * breadcrumb messages, string values under harmless keys and tag values. Every case drives the client and reads the
 * body the transport posted to a stub fetch. Emails and IP addresses are not masked here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addBreadcrumb, captureException, captureMessage, close, flush, init, setTag, type OverseerConfig } from "../index";
import { redact, redactSecrets } from "../../logs/redact";

const DSN = "https://ingest.example.test/api/v1/overseer";
let bodies: string[];

function start(config: Partial<OverseerConfig> = {}): void {
  init({ clientKey: "osk_test", dsn: DSN, includeSourceContext: false, rateLimit: false, ...config });
}

/** Every item of every body, as the platform receives it. */
const items = (): any[] => bodies.flatMap((b) => JSON.parse(b).events as any[]);

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});
afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

/** One line throws every error, so that the place in the fingerprint is the same. */
const resetError = (secret: string): Error => new Error(`reset failed: token=${secret}`);

describe("secrets in text do not reach the wire", () => {
  it("(a) an exception message loses its secrets and keeps its words", async () => {
    start();
    captureException(new Error("reset failed: token=S1 and Authorization: Bearer S2"));
    await flush();
    const body = bodies.join("");
    expect(body).not.toContain("S1");
    expect(body).not.toContain("S2");
    expect(body).toContain("reset failed");
    const [e] = items();
    expect(e.event.message).toContain("reset failed");
    expect(e.event.exception.value).toContain("reset failed");
  });

  it("(b) captureMessage text", async () => {
    start();
    captureMessage("upstream said api_key=S3", "error");
    await flush();
    expect(bodies.join("")).not.toContain("S3");
    expect(bodies.join("")).toContain("upstream said");
  });

  it("(c) a breadcrumb's message and its data", async () => {
    start();
    addBreadcrumb({ category: "auth", message: "login password=S4", data: { note: "Bearer S5" } });
    captureException(new Error("boom"));
    await flush();
    const body = bodies.join("");
    expect(body).not.toContain("S4");
    expect(body).not.toContain("S5");
    expect(body).toContain("login");
  });

  it("(d) a tag under a secret key is dropped, a tag value is scrubbed", async () => {
    start();
    setTag("session_token", "S6");
    setTag("note", "token=S7");
    captureMessage("hello");
    await flush();
    const [m] = items();
    expect(bodies.join("")).not.toContain("S6");
    expect(bodies.join("")).not.toContain("S7");
    expect(m.event?.tags ?? m.tags).toHaveProperty("note");
    expect(JSON.stringify(m)).not.toContain("session_token");
  });

  it("(e) a JWT and a prefixed key inside an extra string under a harmless key are masked", async () => {
    start();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const key = `sk_live_${"x".repeat(24)}`;
    captureException(new Error("boom"), { note: `got ${jwt} then`, nested: { list: [`using ${key}`] } });
    await flush();
    const body = bodies.join("");
    expect(body).not.toContain(jwt);
    expect(body).not.toContain(key);
    expect(body).toContain("[jwt]");
    expect(body).toContain("[token]");
  });

  it("(e) the same for the data of a breadcrumb", async () => {
    start();
    const key = `sk_live_${"x".repeat(24)}`;
    addBreadcrumb({ message: "call", data: { detail: { text: `key ${key}` } } });
    captureException(new Error("boom"));
    await flush();
    expect(bodies.join("")).not.toContain(key);
  });

  it("(f) two errors that differ only by the secret have the same fingerprint", async () => {
    start();
    captureException(resetError("kqzwvtpn"));
    captureException(resetError("mrdhgxsl"));
    await flush();
    const [a, b] = items();
    expect(a.group.fingerprint).toEqual(b.group.fingerprint);
    expect(JSON.stringify(a.group)).not.toContain("kqzwvtpn");
  });

  it("(f) the rate limit groups them too", async () => {
    start({ rateLimit: { perGroupPerMinute: 1, perMinute: 100 } });
    captureException(resetError("kqzwvtpn"));
    captureException(resetError("mrdhgxsl"));
    await flush();
    expect(items()).toHaveLength(1);
  });

  it("(g) beforeSend sees the scrubbed event", async () => {
    const seen: any[] = [];
    start({
      beforeSend: (e) => {
        seen.push(JSON.parse(JSON.stringify(e)));
        return e;
      },
    });
    setTag("session_token", "S6");
    addBreadcrumb({ message: "login password=S4" });
    captureException(new Error("failed token=S1"), { note: "Bearer S5abcdef" });
    await flush();
    expect(seen).toHaveLength(1);
    const text = JSON.stringify(seen[0]);
    for (const s of ["S1", "S4", "S5abcdef", "S6"]) expect(text).not.toContain(s);
    expect(seen[0].message).toContain("failed");
  });

  it("the app's own objects are not changed", async () => {
    start();
    const context = { note: "token=S1" };
    captureException(new Error("boom"), context);
    await flush();
    expect(context.note).toBe("token=S1");
  });
});

describe("(h) text without a secret is unchanged", () => {
  const PLAIN = [
    "Request to https://api.example.com/v1/orders failed with 500",
    "author: ann",
    "signal: 9",
    "design: dark, side: left",
    "user ann@example.com from 203.0.113.7 timed out",
    "ENOENT: no such file or directory, open '/srv/app/config.json'",
    "reset failed",
    "the bearer of bad news",
  ];

  it.each(PLAIN)("redactSecrets keeps %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("an error with such a message goes out as it is, email and IP included", async () => {
    start();
    captureException(new Error("signal: 9 for ann@example.com at 203.0.113.7"), { note: "author: ann" });
    await flush();
    const [e] = items();
    expect(e.event.message).toBe("signal: 9 for ann@example.com at 203.0.113.7");
    expect(e.event.extra.note).toBe("author: ann");
  });

  it("redact keeps masking what it did", () => {
    expect(redact("user ann@example.com token=abc1")).toBe("user [email] token=[secret]");
  });
});

describe("redactSecrets", () => {
  it("uses the placeholders redact uses", () => {
    for (const text of ["token=abc1", "Bearer abcdef123456", "Cookie: a=b", "see /x?token=abc1", `key sk_live_${"x".repeat(20)}`]) {
      expect(redactSecrets(text)).toBe(redact(text));
    }
  });

  it("does not cut a long text", () => {
    const long = `${"word ".repeat(1000)}token=S1`;
    const out = redactSecrets(long);
    expect(out.length).toBeGreaterThan(1000);
    expect(out).not.toContain("S1");
  });

  it("is stable", () => {
    const once = redactSecrets("a token=S1 b Bearer abcdef123456 ?x=1");
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("transactions", () => {
  it("the name and the tags are scrubbed", async () => {
    start();
    const { getClient } = await import("../index");
    getClient()?.captureTransaction({
      type: "transaction",
      event_id: "e1",
      trace_id: "t1",
      span_id: "s1",
      op: "http.server",
      name: "GET /reset?token=S8",
      status: "ok",
      start_timestamp: "2026-01-01T00:00:00.000Z",
      end_timestamp: "2026-01-01T00:00:01.000Z",
      spans: [],
      tags: { session_token: "S9", note: "token=S10" },
    });
    await flush();
    const body = bodies.join("");
    for (const s of ["S8", "S9", "S10"]) expect(body).not.toContain(s);
    expect(body).toContain("GET /reset");
  });
});
