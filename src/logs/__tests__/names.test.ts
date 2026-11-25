import { describe, expect, it } from "vitest";
import { findingEvent } from "../cloud";
import { createLogMonitor } from "../monitor";
import { messageKey, nameOf, redact } from "../redact";
import type { LogMonitor, LogState, LogStore } from "../types";

const C1 = "8daf9ff9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6";
const C2 = "0123abcd9ff9f1c2d3e4f5a6b7c8d9e0f1a2b3c4";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4";

const KEPT: Array<[string, string]> = [
  ["a version", "web@1.4.0"],
  ["a scoped version", "@acme/web@2.0.1-rc.1"],
  ["a commit", C1],
  ["a short commit", "8daf9ff"],
  ["name@commit", `my-app@${C1}`],
  ["words-commit", `main-${C1}`],
  ["words/commit", `release/2026.11/${C1}`],
  ["a version and a commit", `1.4.0+${C1}`],
  ["a version", "1.4.0"],
  ["a v version", "v1.2.3"],
  ["a two part version", "2.7"],
  ["a version with a tail", "1.4.0-rc.1.build.7"],
  ["four parts", "v1.2.3.4"],
  ["dpl", `dpl_${"A1b2C3d4E5".repeat(2)}1234`],
  ["prj", "prj_abc123XYZ789abc123XYZ789"],
  ["a uuid", "123e4567-e89b-12d3-a456-426614174000"],
  ["a date stamp", "20261124153000"],
  ["a date stamp with a dash", "20261124-1530"],
  ["a date stamp with a T", "20261124T153000"],
  ["an epoch in ms", "1795580000123"],
  ["an epoch in s", "1795580000"],
  ["words", "projects-production-checkout-worker-us-east-1"],
  ["words with a dot", "api.checkout"],
  ["a service", "pkg-registry-api"],
  ["a service", "skyline-service"],
  ["a service", "npm-mirror-service"],
  ["a service", "rkv-store-worker"],
  ["a service", "ghost-blog-service"],
];

describe("nameOf keeps the shapes a developer gives a name", () => {
  it.each(KEPT)("%s: %s", (_what, v) => {
    expect(nameOf(v)).toBe(v);
    expect(nameOf(`  ${v}  `)).toBe(v);
  });
  it("is what redact is not: these were masked", () => {
    expect(redact("web@1.4.0")).toBe("[email]");
    expect(redact(C1)).toBe("[hex]");
    expect(redact("projects-production-checkout-worker-us-east-1")).toBe("[secret]");
  });
});

const EMPTY: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["a number", 5],
  ["an object", { a: 1 }],
  ["empty", ""],
  ["blanks", "   \n"],
  ["an email", "bob@example.com"],
  ["an email in a name", "web@bob@example.com"],
  ["an email with a version", "bob@example.com@1.2.3"],
  ["name@ip", "bob@1.2.3.4"],
  ["an email on a digit", "bob@1.example.com"],
  ["a token in words", "web-ghp_abcdef1234567"],
  ["a key in words", "web-sk_abcdef1234567"],
  ["a short jwt after a version", "1.4.0-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0.abcdefgh"],
  ["an ip", "10.0.0.5"],
  ["an ip in words", "a-10.0.0.5"],
  ["an ip after a version", "1.2.3-4.5.6.7"],
  ["an ip with a commit", "10.0.0.5-abcdef1"],
  ["ipv6", "::1"],
  ["ipv6 long", "2001:db8::7"],
  ["a jwt", JWT],
  ["a jwt in a name", `main-${JWT}`],
  ["a jwt after a version", `1.4.0-${JWT}`],
  ["a bearer token", "Bearer abc123def456"],
  ["a bearer in a name", "web Bearer abc123def456"],
  ["a pair", "token=abc123"],
  ["a pair after a version", "v1.2.3 token=abc123"],
  ["a quoted pair", 'password: "hunter2secret"'],
  ["a cookie", "cookie=session123"],
  ["a query", "web?token=abc"],
  ["a stripe key", "sk_live_abcdefghijklmnop"],
  ["a key after a version", "1.4.0-sk_live_abcdefghijklmnop"],
  ["a key after a name", "web@1.4.0-sk_live_abcdefghijklmnop"],
  ["a github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["a github token in a name", "main-ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["an aws key", "AKIAIOSFODNN7EXAMPLE"],
  ["a 41 character hex run", "a".repeat(41)],
  ["a 64 character hex run", "0123456789abcdef".repeat(4)],
  ["a 40 character base64 run", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k"],
  ["a mixed run in words", "web-aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k"],
  ["a card", "4242424242424242"],
  ["a card in a dpl id", "dpl_4242424242424242"],
  ["a card after words", "main-4242424242424242"],
  ["a mask", "[secret]"],
  ["a mask in words", "web-[hex]"],
  ["an old release", "my-app@[hex]"],
  ["an old email mask", "@acme/[email]"],
  ["a mask by a long name", `${"word ".repeat(12)}token=abc`],
];

describe("nameOf drops what is personal, secret or no name", () => {
  it("has at least 25 rows", () => expect(EMPTY.length).toBeGreaterThanOrEqual(25));
  it.each(EMPTY)("%s", (_what, v) => {
    expect(nameOf(v)).toBe("");
  });
  it("cuts to 64 and keeps no mask", () => {
    const n = nameOf("Checkout service for the shop ".repeat(10));
    expect(n.length).toBeGreaterThan(0);
    expect(n.length).toBeLessThanOrEqual(64);
    expect(nameOf("1.0.0-" + "abcdefghij".repeat(2) + "-" + "abcdefghij".repeat(2) + "-" + "abcdefghij".repeat(2))).toBe("");
  });
  it("lets an app's own pattern win, even over a shape", () => {
    expect(nameOf("web@1.4.0", [/web@/])).toBe("");
    expect(nameOf("acme-prod", [/acme/g])).toBe("");
    expect(nameOf("acme-prod", [/acme/g])).toBe("");
    expect(nameOf("shop-prod", [/acme/])).toBe("shop-prod");
  });
});

describe("nameOf is stable and bounded", () => {
  const pieces = ["web", "@", "1.4.0", "-", "+", ".", "_", "/", C1, "8daf9ff", "v", "1", "20261124", "dpl_", "prj_", "sk_live_", "ghp_", "token=", "bob@example.com", "10.0.0.5", "::", ":", "eyJ", JWT, "Bearer ", "?", "[hex]", " ", "abc", "Z", "4242424242424242", "projects-production", "a".repeat(30), "é"];
  it("nameOf(nameOf(x)) is nameOf(x) on 5,000 random strings", () => {
    let seed = 7;
    const rnd = (n: number): number => Math.floor(((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * n);
    for (let i = 0; i < 5000; i++) {
      let s = "";
      for (let j = 0, n = 1 + rnd(8); j < n; j++) s += pieces[rnd(pieces.length)];
      const once = nameOf(s);
      expect(nameOf(once), JSON.stringify(s)).toBe(once);
      expect(once.length).toBeLessThanOrEqual(64);
      // `v10.0.0.5` is a version by the shape (`v1.2.3.4` must stay), so a `v` before the address is allowed.
      expect(once).not.toMatch(/bob@example|(?<![\dv.])10\.0\.0\.5(?!\d)|eyJ[\w-]{5,}\.|\bsk_live_\w{8}|\bghp_\w{8}/);
    }
  });
  it("takes under 5 ms on hostile input of 64 and of 100,000 characters", () => {
    const inputs = ["a-", "1.", "a@", "-", "a", "0123456789abcdef", "1.2.3-", "a.", "@", "v1."].flatMap((p) => [p.repeat(Math.ceil(64 / p.length)).slice(0, 64), p.repeat(Math.ceil(100_000 / p.length)).slice(0, 100_000)]);
    for (const s of inputs) nameOf(s);
    for (const s of inputs) {
      const t = performance.now();
      nameOf(s);
      expect(performance.now() - t, `${s.length} ${s.slice(0, 8)}`).toBeLessThan(5);
    }
  });
});

class MemStore implements LogStore {
  saves = 0;
  constructor(public state?: unknown) {}
  load(): unknown {
    return this.state === undefined ? undefined : JSON.parse(JSON.stringify(this.state));
  }
  save(state: LogState): void {
    this.saves += 1;
    this.state = JSON.parse(JSON.stringify(state));
  }
}
const live: LogMonitor[] = [];
const make = (o: Parameters<typeof createLogMonitor>[0]): LogMonitor => {
  const m = createLogMonitor({ onBatch: () => undefined, ...o });
  live.push(m);
  return m;
};

describe("a release and a service in the monitor", () => {
  it("two commits are two releases: in the finding, the event, and after a save and a load", async () => {
    const store = new MemStore();
    const m = make({ store, service: "checkout-worker" });
    m.record({ level: "error", message: "payment failed", release: C1 });
    m.record({ level: "error", message: "payment failed", release: C2 });
    const f = m.findings()[0];
    expect(f.releases).toEqual([C1, C2]);
    expect(f.service).toBe("checkout-worker");
    const ev = findingEvent(f, {});
    expect(ev.release).toBe(C2);
    expect((ev.extra as { releases: string[] }).releases).toEqual([C1, C2]);
    expect(ev.tags?.service).toBe("checkout-worker");
    await m.flush();
    await m.stop();
    const again = make({ store });
    expect(again.findings()[0].releases).toEqual([C1, C2]);
    expect(again.findings()[0].service).toBe("checkout-worker");
  });
  it("keeps web@1.4.0 and a scoped name, and sends the release of the options when the finding has none", () => {
    const m = make({ release: "@acme/web@2.0.1-rc.1", service: "web@1.4.0" });
    m.record({ level: "error", message: "boom" });
    const f = m.findings()[0];
    expect(f.releases).toEqual(["@acme/web@2.0.1-rc.1"]);
    expect(f.service).toBe("web@1.4.0");
    expect(findingEvent({ ...f, releases: [] }, { release: "web@1.4.0" }).release).toBe("web@1.4.0");
  });
  it("a masked release sends no release, no service and no entry in releases", () => {
    const m = make({ release: "bob@example.com", service: "10.0.0.5" });
    m.record({ level: "error", message: "boom", release: `token=abc`, service: "[secret]" });
    const f = m.findings()[0];
    expect(f.releases).toEqual([]);
    expect(f.service).toBeUndefined();
    const ev = findingEvent(f, { release: "bob@example.com" });
    expect("release" in ev).toBe(false);
    expect(ev.tags && "service" in ev.tags).toBe(false);
    expect((ev.extra as { releases: string[] }).releases).toEqual([]);
    expect(findingEvent({ ...f, releases: ["[hex]", "web@1.4.0"], service: "[token]" }, {}).release).toBe("web@1.4.0");
  });
  it("an app's own pattern wins for a release", () => {
    const m = make({ release: "acme-1.0.0", redact: [/acme/] });
    m.record({ level: "error", message: "boom" });
    expect(m.findings()[0].releases).toEqual([]);
  });
  it("loads a state an older version wrote with [hex] in it, dropping those names", async () => {
    const store = new MemStore();
    const m = make({ store, release: C1, service: "web" });
    m.record({ level: "error", message: "boom" });
    await m.flush();
    await m.stop();
    const old = JSON.parse(JSON.stringify(store.state)) as LogState & { groups: Array<{ releases: string[]; service?: string }> };
    old.groups[0].releases = ["[hex]", "my-app@[hex]", "web@1.4.0", "[hex]"];
    old.groups[0].service = "[token]";
    const again = make({ store: new MemStore(old) });
    const f = again.findings();
    expect(f).toHaveLength(1);
    expect(f[0].releases).toEqual(["web@1.4.0"]);
    expect(f[0].service).toBeUndefined();
    expect(again.stats().errors).toBe(0);
  });
});

describe("the prefixed secrets have their own form", () => {
  const words = ["skipped_records for job", "skeleton-loader failed", "pkg-registry-api down", "ghost-blog-service down", "npm_config_registry unset", "ASIAPACIFIC-region slow", "npm-mirror-service down", "rkv-store-worker down", "ghoul_attack happened"];
  it.each(words)("%s stays words", (w) => {
    expect(redact(w)).toBe(w);
    expect(messageKey(`error ${w}`)).toContain(w.split(" ")[0]);
  });
  it("groups differ by those words", () => {
    expect(messageKey("skipped_records for job")).not.toBe(messageKey("pkg_records for job"));
    expect(messageKey("skipped_records for job")).toBe("skipped_records for job");
  });
  const secrets = [
    "sk_live_abcdefghij", "sk-live_ABCdef1234567890xyz", "pk_test_abcdefgh12", "rk_live_abcdefgh12", "whsec_abcdefgh12", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "gho_abcdefgh12", "ghu_abcdefgh12",
    "ghs_abcdefgh12", "ghr_abcdefgh12", "github_pat_11ABCDEFG0abcdefgh", "glpat-abcdefgh12", "xoxb-abcdefgh12", "xoxp-1234-abcdefgh", "npm_abcdefghijklmnopqrstuvwxyz0123", "AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE",
    "AIzaSyA1234567890abcdefghijklmn", "ya29.a0AfH6SMBabcdefgh", "ya29_abcdefgh12", "ya29-abcdefgh12",
  ];
  it.each(secrets)("%s is masked", (s) => {
    expect(redact(s)).toBe("[token]");
    expect(redact(`key ${s} failed`)).toBe("key [token] failed");
    expect(nameOf(s)).toBe("");
  });
  it("needs its separator and its length", () => {
    expect(redact("sk12345678abc")).toBe("sk12345678abc");
    expect(redact("npm_abcdefgh")).toBe("npm_abcdefgh");
    expect(redact("AKIAshort")).toBe("AKIAshort");
  });
});
