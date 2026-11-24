import { describe, expect, it } from "vitest";
import { messageKey, pathPattern, redact, shortId, uaFamily } from "../redact";

// A small seeded generator, so a failing case can be replayed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const chars = (r: () => number, alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const TABLE: Array<[string, string, string]> = [
  ["email", "contact jane.doe+x@example.co.uk now", "contact [email] now"],
  ["ipv4", "from 192.168.1.20 failed", "from [ip] failed"],
  ["ipv6 compressed", "client 2001:db8::1 refused", "client [ip] refused"],
  ["ipv6 loopback", "listening on ::1", "listening on [ip]"],
  ["ipv6 full", "peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 gone", "peer [ip] gone"],
  ["clock is not an address", "at 12:30:45 done", "at 12:30:45 done"],
  ["bearer", "Authorization: Bearer abcdef123456", "Authorization: Bearer [token]"],
  ["jwt", "t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_abc-123", "t [jwt]"],
  ["token pair", "login token=abc123xyz ok", "login token=[secret] ok"],
  ["quoted pair", 'password: "hunter two"', "password=[secret]"],
  ["api key pair", "api_key=AbC123", "api_key=[secret]"],
  ["query string", "GET /a/b?x=1&y=2 failed", "GET /a/b?[q] failed"],
  ["question mark kept", "why did it fail?", "why did it fail?"],
  ["prefixed key", "using sk-live_abcdefghijkl1234 here", "using [token] here"],
  ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789 pushed", "[token] pushed"],
  ["cookie", "cookie: sid=abc; theme=dark", "cookie=[cookie]"],
  ["long hex", "id 0123456789abcdef0123456789abcdef01234567", "id [hex]"],
  ["long mixed run", "key Zm9vYmFyMTIzNDU2Nzg5MEFCQ2RlZmdoaWo", "key [secret]"],
  ["card number", "card 4242424242424242 and 4242 4242 4242 4242", "card [num] and [num]"],
  ["id in a path", "GET /users/12345/orders", "GET /users/:id/orders"],
  ["uuid", "order 123e4567-e89b-12d3-a456-426614174000 failed", "order [uuid] failed"],
  ["plain text kept", "database connection refused", "database connection refused"],
];

describe("redact: table", () => {
  for (const [name, input, expected] of TABLE) {
    it(name, () => {
      expect(redact(input)).toBe(expected);
    });
  }

  it("takes any value without throwing", () => {
    for (const v of [undefined, null, 0, NaN, {}, [], Symbol.iterator.toString(), new Error("boom: token=abc123"), { a: { b: "x@y.zz" } }, "\u0000\uD800"]) {
      expect(typeof redact(v)).toBe("string");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redact(cyclic)).toBe("");
  });

  it("cuts an enormous text before any pattern runs", () => {
    const t0 = performance.now();
    const out = redact(`${"a".repeat(200_000)}@${"b.".repeat(100_000)}`);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("applies your own patterns first and keeps them stable", () => {
    const own = [/ORDER-\d{6}/g];
    const once = redact("failed ORDER-123456 for jane@example.com", own);
    expect(once).toBe("failed [redacted] for [email]");
    expect(redact(once, own)).toBe(once);
  });
});

describe("redact: property", () => {
  const secrets = (r: () => number): string[] => [
    `${chars(r, "abcdefghij", 6)}.${chars(r, "klmnop", 3)}@${chars(r, "qrstuv", 5)}.com`,
    `${1 + Math.floor(r() * 254)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}.${1 + Math.floor(r() * 254)}`,
    `2001:db8:${(Math.floor(r() * 0xffff)).toString(16)}::${(1 + Math.floor(r() * 0xfff)).toString(16)}`,
    `Bearer ${chars(r, ALNUM, 24)}`,
    `eyJ${chars(r, ALNUM, 12)}.eyJ${chars(r, ALNUM, 16)}.${chars(r, ALNUM, 14)}`,
    `sk-${chars(r, ALNUM, 24)}`,
    `${pick(r, ["token", "secret", "api_key", "password", "session"])}=${chars(r, ALNUM, 10)}`,
    `${chars(r, "0123456789abcdef", 32)}`,
  ];
  const filler = ["error", "while", "calling", "/api/orders", "failed:", "user", "retry", "(", ")", ",", "[", "]", "?", "=", ":", ";", '"', "'", "-", "_", "12", "3.5", "at", "\n"];

  it("never leaves a planted secret in the output, wherever it sits", () => {
    const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      const planted = pick(r, secrets(r));
      const parts = Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(r, filler));
      parts.splice(Math.floor(r() * (parts.length + 1)), 0, planted);
      const text = parts.join(pick(r, [" ", " ", ",", "\t"]));
      const out = redact(text);
      // The secret's own value: the part after `=` for a pair, else the whole thing.
      const needle = planted.includes("=") ? planted.split("=")[1] : planted.replace(/^Bearer /, "");
      expect(out, `case ${i}: ${JSON.stringify(text)}`).not.toContain(needle);
    }
  });

  it("is stable: redact(redact(x)) === redact(x), for every table text and 20,000 random ones", () => {
    for (const [, input] of TABLE) expect(redact(redact(input))).toBe(redact(input));
    const r = rng(11);
    const atoms = [...secrets(r), ...filler, "token=[secret]", "?[q]", "[email]", "[ip]", "Bearer [token]", "cookie=[cookie]", "/:id", "key: [secret]", "a=b", "::", "::1", "1::", "abc:def"];
    for (let i = 0; i < 20_000; i++) {
      const parts = Array.from({ length: 1 + Math.floor(r() * 10) }, () => (r() < 0.35 ? pick(r, secrets(r)) : pick(r, atoms)));
      const text = parts.join(pick(r, [" ", "", "=", ":", ", "]));
      const once = redact(text);
      expect(redact(once), `case ${i}: ${JSON.stringify(text)} -> ${JSON.stringify(once)}`).toBe(once);
    }
  });

  it("is stable for token pairs in particular (the shape a naive pair pattern breaks on)", () => {
    for (const text of ["token=abc", "token=abc,token=def", 'token="a b"', "x token: t1 y secret=s2", "token=[secret]", "token=[secret]]", "password=[token]"]) {
      expect(redact(redact(text))).toBe(redact(text));
    }
    expect(redact("token=abc")).toBe("token=[secret]");
  });
});

describe("keys", () => {
  it("folds numbers, ids, hashes, dates and quoted values of a message into one key", () => {
    const a = messageKey('order 8812 for user "alice" failed at 2026-11-24T10:00:01Z after 35ms (req 9f3a1b2c)');
    const b = messageKey('order 9 for user "bob smith" failed at 2026-11-25T11:20:59Z after 2.5s (req 11ee22dd)');
    expect(a).toBe(b);
    expect(a).toBe("order # for user [v] failed at [ts] after [dur] (req [hex])");
  });

  it("keeps the first line and the file of the first stack frame, without its hash", () => {
    const k = messageKey("TypeError: x is undefined\n    at run (/srv/app/.next/server/chunks/page-3fa9c1d2.js:10:5)\n    at other (/srv/b.js:1:1)");
    expect(k).toBe("TypeError: x is undefined @ page-[hash].js");
  });

  it("keeps a key under 200 characters even for a long line", () => {
    expect(messageKey("x".repeat(5000)).length).toBeLessThanOrEqual(160);
  });

  it("makes a path pattern: no origin, no query, ids folded", () => {
    expect(pathPattern("https://shop.example.com/users/42/orders/123e4567-e89b-12d3-a456-426614174000?token=abc")).toBe("/users/:n/orders/:uuid");
    expect(pathPattern("/_next/static/chunks/abc.js")).toBe("/_next/static/*");
    expect(pathPattern("/a/".padEnd(300, "b")).length).toBeLessThanOrEqual(90);
    expect(pathPattern(undefined)).toBe("/");
  });

  it("reduces a user agent to a family", () => {
    expect(uaFamily("Mozilla/5.0 (X11; Linux) Chrome/120.0 Safari/537.36")).toBe("browser");
    expect(uaFamily("curl/8.4.0")).toBe("curl");
    expect(uaFamily("Googlebot/2.1")).toBe("bot");
    expect(uaFamily("node-fetch/1.0")).toBe("node");
    expect(uaFamily(undefined)).toBe("other");
  });

  it("gives the same short id for the same key", () => {
    expect(shortId("GET|/a|500")).toBe(shortId("GET|/a|500"));
    expect(shortId("GET|/a|500")).not.toBe(shortId("GET|/a|501"));
    expect(shortId("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});
