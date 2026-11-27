/**
 * The context scrubber drops the keys that name a secret (more than cookie, token, secret and password) and cleans
 * class instances instead of passing them whole: a database document with a password hash, an Error, a URL with a query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addBreadcrumb, captureException, close, flush, init, type OverseerEvent } from "../index";
import { sanitizeExtra } from "../sanitize-extra";
import { redact } from "../../logs/redact";
import { isSecretKey, SECRET_WORDS } from "../secret-keys";

const DROPPED = [
  "apiKey", "api_key", "api-key", "x-api-key", "X-API-KEY", "privateKey", "private_key", "private-key",
  "credentials", "userCredential", "pwd", "passwd", "auth", "Auth", "oauth", "authorization", "session", "sessionId", "sid", "SID",
  "userSid", "user_sid", "x-sid", "sig", "x-sig", "jwt", "idJwt", "signature", "cardNumber", "card_number", "card-number",
  "cvv", "cvc", "cookie", "set-cookie", "token", "secret", "password", "passwordHash",
];
const KEPT = ["author", "authority", "side", "sidebar", "design", "signal", "consider", "orderId", "Author", "signed"];

describe("secret key names", () => {
  it.each(DROPPED)("drops %s at the top level and two levels down", (key) => {
    const out = sanitizeExtra({ [key]: "SECRET", keep: { a: { [key]: "SECRET", note: "n" } } });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out).toEqual({ keep: { a: { note: "n" } } });
  });

  it("matches in any case", () => {
    expect(sanitizeExtra({ APIKEY: "SECRET", Password: "SECRET", CVV: "SECRET", JWT: "SECRET", note: "n" })).toEqual({ note: "n" });
  });

  it.each(KEPT)("keeps %s", (key) => {
    expect(sanitizeExtra({ [key]: "v", deep: { x: { [key]: "v" } } })).toEqual({ [key]: "v", deep: { x: { [key]: "v" } } });
  });

  it("the log redactor and the scrubber share one word list", () => {
    for (const word of ["token", "secret", "password", "passwd", "pwd", "api_key", "apikey", "auth", "signature", "session", "credential"]) {
      expect(new RegExp(SECRET_WORDS, "i").test(word)).toBe(true);
      expect(isSecretKey(word)).toBe(true);
      expect(redact(`${word}=abc1`)).toBe(`${word}=[secret]`);
    }
    expect(redact("author=abc1")).toBe("author=abc1");
  });
});

class Account {
  constructor(readonly id: number, readonly passwordHash: string) {}
}

describe("objects that are not plain", () => {
  it("a class instance keeps id and drops passwordHash", () => {
    expect(sanitizeExtra({ user: new Account(7, "SECRET") })).toEqual({ user: { id: 7 } });
  });

  it("an instance's toJSON is cleaned", () => {
    const doc = { toJSON: () => ({ email: "a@b.c", password: "SECRET", profile: { token: "SECRET", name: "n" } }) };
    const out = sanitizeExtra({ user: Object.create({ toJSON: doc.toJSON }) });
    expect(out).toEqual({ user: { email: "a@b.c", profile: { name: "n" } } });
  });

  it("a plain object's toJSON is cleaned too, not left for the serializer to call", () => {
    const out = sanitizeExtra({ doc: { toJSON: () => ({ email: "a@b.c", password: "SECRET" }) }, own: { toJSON: function (this: object) { return this; }, id: 1, password: "SECRET" } });
    expect(out).toEqual({ doc: { email: "a@b.c" }, own: { id: 1 } });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("a toJSON that throws gives [Unserializable] and capture does not throw", () => {
    class Bad {
      toJSON(): never {
        throw new Error("nope");
      }
    }
    expect(sanitizeExtra({ bad: new Bad(), ok: 1 })).toEqual({ bad: "[Unserializable]", ok: 1 });
    expect(() => captureException(new Error("x"), { bad: new Bad() })).not.toThrow();
  });

  it("an Error becomes name and message, with its cause cleaned the same way", () => {
    expect(sanitizeExtra({ err: new Error("boom", { cause: new Error("root") }) })).toEqual({
      err: { name: "Error", message: "boom", cause: { name: "Error", message: "root" } },
    });
    expect(sanitizeExtra({ err: new TypeError("t") })).toEqual({ err: { name: "TypeError", message: "t" } });
    expect(sanitizeExtra({ err: new Error("e", { cause: { password: "SECRET", id: 1 } }) })).toEqual({ err: { name: "Error", message: "e", cause: { id: 1 } } });
  });

  it("an Error that is its own cause is cut", () => {
    const e = new Error("loop");
    (e as { cause?: unknown }).cause = e;
    expect(sanitizeExtra({ e })).toEqual({ e: { name: "Error", message: "loop", cause: "[Circular]" } });
  });

  it("a URL gives origin and path only", () => {
    const url = new URL("https://user:pw@api.example.com/v1/items?token=SECRET#SECRETFRAG");
    expect(sanitizeExtra({ target: url })).toEqual({ target: "https://api.example.com/v1/items" });
  });

  it("Date, Map, Set and typed arrays are kept", () => {
    const d = new Date(0);
    const m = new Map([["a", 1]]);
    const s = new Set([1]);
    const u = new Uint8Array(2);
    const out = sanitizeExtra({ d, m, s, u, re: /x/ });
    expect(out.d).toBe(d);
    expect(out.m).toBe(m);
    expect(out.s).toBe(s);
    expect(out.u).toBe(u);
    expect(out.re).toEqual(/x/);
  });

  it("a request-like instance is still dropped", () => {
    class Req {
      headers = { a: "SECRET" };
      method = "GET";
    }
    expect(sanitizeExtra({ r: new Req(), k: 1 })).toEqual({ k: 1 });
  });

  it("a cycle through a class instance gives [Circular]", () => {
    class Node {
      next?: Node;
      constructor(readonly id: number) {}
    }
    const a = new Node(1);
    const b = new Node(2);
    a.next = b;
    b.next = a;
    expect(sanitizeExtra({ a })).toEqual({ a: { id: 1, next: { id: 2, next: "[Circular]" } } });
  });

  it("the depth cap still applies through class instances", () => {
    class Wrap {
      constructor(readonly inner: unknown) {}
    }
    let v: unknown = { leaf: 1 };
    for (let i = 0; i < 8; i++) v = new Wrap(v);
    let o = sanitizeExtra({ v }).v as Record<string, unknown>;
    let levels = 1;
    while (typeof o === "object" && o !== null && "inner" in o) {
      o = o.inner as Record<string, unknown>;
      levels++;
    }
    expect(o).toBe("[Truncated]");
    expect(levels).toBeLessThanOrEqual(6);
  });
});

describe("through a real capture", () => {
  let bodies: string[];
  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }),
    );
    init({ clientKey: "osk_test", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, rateLimit: false } as any);
  });
  afterEach(() => {
    close();
    vi.unstubAllGlobals();
  });

  it("a breadcrumb's data follows the same rules", async () => {
    let seen: OverseerEvent | undefined;
    close();
    init({ clientKey: "osk_test", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, beforeSend: (e: OverseerEvent) => ((seen = e), null) } as any);
    addBreadcrumb({ type: "log", message: "m", data: { apiKey: "k", note: "n", user: new Account(1, "h") } });
    captureException(new Error("x"));
    expect(seen!.breadcrumbs![0]!.data).toEqual({ note: "n", user: { id: 1 } });
  });

  it("no secret value is on the wire", async () => {
    addBreadcrumb({ type: "log", message: "m", data: { apiKey: "SECRET_CRUMB", note: "n" } });
    captureException(new Error("boom"), {
      user: new Account(1, "SECRET_HASH"),
      doc: { toJSON: () => ({ email: "a@b.c", password: "SECRET_PW" }) },
      target: new URL("https://api.example.com/v1?token=SECRET_URL"),
      "x-api-key": "SECRET_XAPIKEY",
      cardNumber: "SECRET_CARD",
      cvv: "SECRET_CVV",
      auth: "SECRET_AUTH",
      cause: new Error("outer", { cause: new Error("inner") }),
    });
    await flush();
    const wire = bodies.join("\n");
    expect(wire).toContain("boom");
    expect(wire).toContain("a@b.c");
    expect(wire).not.toContain("SECRET");
  });
});
