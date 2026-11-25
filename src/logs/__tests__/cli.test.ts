import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../cli-main";
import { scratch } from "./helpers";

// The built command, as a child process. Skips before a build; CI runs this file again after `npm run build`.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "dist", "logs", "cli.js");
const hasDist = existsSync(cli);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; bin: Record<string, string> };
const example = join(root, "examples", "log-read", "logs");
const dir = scratch("cli");
let guard = "";

/** Preloaded into a child: every way to open a socket or ask a name server throws, and the attempt is written to NET_LOG. */
const GUARD = `import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { appendFileSync } from "node:fs";
const log = process.env.NET_LOG;
const refuse = (what) => () => { appendFileSync(log, what + "\\n"); throw new Error("network is off: " + what); };
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
net.Socket.prototype.connect = refuse("Socket.connect");
http.request = refuse("http.request");
http.get = refuse("http.get");
https.request = refuse("https.request");
https.get = refuse("https.get");
dns.lookup = refuse("dns.lookup");
globalThis.fetch = refuse("fetch");
`;

interface Run {
  args: string[];
  input?: string | Buffer;
  env?: Record<string, string>;
  net?: boolean;
  cwd?: string;
}
let netLog = "";
const run = ({ args, input, env, net = true, cwd }: Run): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [...(net ? ["--import", guard] : []), cli, ...args], {
    encoding: "utf8",
    input,
    cwd,
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "", NET_LOG: netLog, ...env },
  });
/** The same without blocking this process, for a test that has a server of its own to answer the child. */
const runAsync = (args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "", ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => (stdout += d));
    c.stderr.on("data", (d: Buffer) => (stderr += d));
    c.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
const attempts = (): string => (existsSync(netLog) ? readFileSync(netLog, "utf8") : "");
const file = (name: string, content: string | Buffer): string => {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
};
const findings = (r: SpawnSyncReturns<string>): Array<Record<string, any>> => (JSON.parse(r.stdout) as { findings: Array<Record<string, any>> }).findings;
// What must never be on a screen: an escape, a control character other than the line ends, a C1 character, a bidi override.
const SCREEN_BAD = /[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/; // eslint-disable-line no-control-regex

beforeAll(() => {
  guard = file("guard.mjs", GUARD);
  netLog = join(dir, "net.log");
});

describe.skipIf(!hasDist)("codmir-logs (the built file)", () => {
  it("is listed in package.json, starts with the node line and is executable", () => {
    expect(pkg.bin).toEqual({ "codmir-logs": "./dist/logs/cli.js" });
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(cli).mode & 0o111).not.toBe(0);
  });

  describe("the planted bug of the example, on every format, with no socket opened", () => {
    const TITLE = "report failed for user #: upstream rejected api_key=[secret]";
    const EXPECT: Record<string, [string, string, string]> = {
      "access.log": ["clf", "GET /report answers 500", "alarm"],
      "app.json.jsonl": ["json", TITLE, "new"],
      "app.log": ["text", TITLE, "new"],
      "app.pino.jsonl": ["pino", "report failed for user #: Error: upstream rejected api_key=[secret]", "new"],
      "container.log": ["auto", TITLE, "new"],
      "journal.jsonl": ["journald", TITLE, "new"],
      "railway.jsonl": ["railway", TITLE, "new"],
      "vercel-cli.jsonl": ["vercel", "GET /api/report answers 500", "alarm"],
      "vercel-drain.jsonl": ["vercel", "GET /api/report answers 500", "alarm"],
    };

    it("has a file for every row", () => {
      expect(readdirSync(example).sort()).toEqual(Object.keys(EXPECT).sort());
    });

    for (const [name, [format, title, judgement]] of Object.entries(EXPECT)) {
      for (const f of ["auto", format]) {
        it(`${name} as ${f}: one finding, five hits, the key masked`, () => {
          const r = run({ args: [join(example, name), "--format", f, "--json"] });
          expect(r.stderr).toBe("");
          expect(r.status).toBe(0);
          const all = findings(r);
          expect(all).toHaveLength(1);
          expect(all[0]).toMatchObject({ title, judgement, hits: 5 });
          expect(all[0].firstSeen).toBe("2026-11-24T10:01:00.000Z");
          expect(all[0].lastSeen).toBe("2026-11-24T10:01:40.000Z");
          expect(r.stdout).not.toContain("sk_live");
          expect(attempts()).toBe("");
        });
      }
    }

    it("prints the short table and a summary line", () => {
      const r = run({ args: [join(example, "app.log")] });
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^JUDGED\s+HITS\s+ID\s+TITLE\s+FIRST SEEN\s+LAST SEEN$/);
      expect(lines[1]).toMatch(/^new\s+5\s+[0-9a-f]{8}\s+report failed for user #: upstream rejected api_key=\[secret\]\s+2026-11-24 10:01:00\s+2026-11-24 10:01:40$/);
      expect(lines[2]).toBe("read 8 lines (662 B): 7 records, 0 requests, 1 skipped. 1 finding: 1 new.");
      expect(r.stdout).not.toContain("\u001b");
    });

    it("reads standard input, with or without -, and a gzip file", () => {
      const text = readFileSync(join(example, "app.log"));
      for (const args of [[], ["-"], ["--format", "text"]]) expect(findings(run({ args: [...args, "--json"], input: text }))[0].title).toBe(TITLE);
      expect(findings(run({ args: ["--json"], input: gzipSync(text) }))[0].hits).toBe(5);
      expect(findings(run({ args: [file("app.log.gz", gzipSync(text)), "--json"] }))[0].hits).toBe(5);
      expect(findings(run({ args: [join(example, "app.log"), "-", "--json"], input: text }))[0].hits).toBe(10);
    });
  });

  describe("help, version and a wrong call", () => {
    it("--help and --version", () => {
      const h = run({ args: ["--help"] });
      expect(h.status).toBe(0);
      expect(h.stdout).toContain("Usage");
      expect(h.stdout).toContain("--fail-on");
      expect(run({ args: ["--version"] }).stdout).toBe(`${pkg.version}\n`);
    });

    const wrong: Array<[string, string[]]> = [
      ["an unknown option", ["--nope"]],
      ["a missing value", ["--format"]],
      ["a bad format", ["--format", "xml"]],
      ["a bad --fail-on", ["--fail-on", "sometimes"]],
      ["a bad --min-status", ["--min-status", "abc"]],
      ["a bad --level", ["--level", "loud"]],
      ["a bad --top", ["--top", "0"]],
      ["--known outside mark", ["--known", "x"]],
      ["mark without --state", ["mark", "abcd1234", "--fixed"]],
      ["mark without --known or --fixed", ["mark", "abcd1234", "--state", "s.json"]],
      ["mark with both", ["mark", "abcd1234", "--known", "x", "--fixed", "--state", "s.json"]],
      ["--cloud without a key", ["--cloud", "x.log"]],
    ];
    for (const [what, args] of wrong) {
      it(`exits 2 for ${what}`, () => {
        const r = run({ args, input: "" });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/^codmir-logs: /);
        expect(r.stdout).toBe("");
        expect(attempts()).toBe("");
      });
    }

    it("exits 2 for a file that does not exist, a folder and a corrupt gzip", () => {
      expect(run({ args: [join(dir, "nope.log")] })).toMatchObject({ status: 2, stderr: expect.stringContaining("ENOENT") });
      expect(run({ args: [dir] })).toMatchObject({ status: 2, stderr: expect.stringContaining("folder") });
      const bad = file("bad.gz", Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.from("this is not a gzip stream at all")]));
      expect(run({ args: [bad] }).status).toBe(2);
      const secret = file("secret.log", "ERROR x\n");
      chmodSync(secret, 0);
      if (process.getuid?.() !== 0) expect(run({ args: [secret] }).status).toBe(2);
    });
  });

  describe("--fail-on", () => {
    const quiet = file("quiet.log", "2026-11-24T10:00:00Z INFO all good\n");
    const noise = file("noise.log", Array.from({ length: 4 }, (_, i) => `203.0.113.${i} - - [24/Nov/2026:10:00:0${i} +0000] "GET /wp-login.php HTTP/1.1" 404 0 "-" "Googlebot"`).join("\n"));
    const code = (f: string, rule: string, extra: string[] = []): number | null => run({ args: [f, "--fail-on", rule, ...extra] }).status;

    it("is 0 for every rule when there is nothing, and when there is only noise", () => {
      for (const rule of ["new", "alarm", "any"]) {
        expect(code(quiet, rule), `quiet ${rule}`).toBe(0);
        expect(code(noise, rule), `noise ${rule}`).toBe(0);
      }
    });

    it("new: 1 for a new finding, any: 1, alarm: 1 only for an alarm", () => {
      const newOnly = join(example, "app.json.jsonl");
      const alarm = join(example, "access.log");
      expect([code(newOnly, "new"), code(newOnly, "any"), code(newOnly, "alarm")]).toEqual([1, 1, 0]);
      expect([code(alarm, "new"), code(alarm, "any"), code(alarm, "alarm")]).toEqual([1, 1, 1]);
    });

    it("without --fail-on the exit is 0 whatever is found", () => {
      expect(run({ args: [join(example, "access.log")] }).status).toBe(0);
    });

    it("with --state, a finding that is not new any more is 0 for new and 1 for any", () => {
      const state = join(dir, "failon-state.json");
      const f = join(example, "app.json.jsonl");
      expect(code(f, "new", ["--state", state])).toBe(1);
      expect(code(f, "new", ["--state", state])).toBe(0);
      expect(code(f, "any", ["--state", state])).toBe(1);
    });
  });

  describe("--state, and mark", () => {
    const f = join(example, "app.json.jsonl");
    const judged = (state: string): { judgement: string; id: string } => {
      const r = run({ args: [f, "--state", state, "--json"] });
      expect(r.status).toBe(0);
      return findings(r)[0] as { judgement: string; id: string };
    };

    it("a second run over the same file knows what is new; the file holds nothing raw and is private", () => {
      const state = join(dir, "two-runs.json");
      expect(judged(state).judgement).toBe("new");
      expect(statSync(state).mode & 0o777).toBe(0o600);
      const second = judged(state);
      expect(second.judgement).toBe("seen");
      const saved = readFileSync(state, "utf8");
      expect(saved).not.toContain("sk_live");
      expect(JSON.parse(saved)).toMatchObject({ version: 1 });
      expect(JSON.parse(saved).groups[0].total).toBe(10);
    });

    it("mark --known makes it known, with the note kept in the state", () => {
      const state = join(dir, "known.json");
      const { id } = judged(state);
      const m = run({ args: ["mark", id, "--known", "tracked in the board", "--state", state] });
      expect(m.status).toBe(0);
      expect(m.stdout).toBe(`marked ${id} as known\n`);
      expect(m.stderr).toBe("");
      const again = findings(run({ args: [f, "--state", state, "--json"] }))[0];
      expect(again).toMatchObject({ judgement: "known", known: "tracked in the board" });
    });

    it("mark --fixed makes the next hit back", () => {
      const state = join(dir, "fixed.json");
      const { id } = judged(state);
      expect(run({ args: ["mark", id, "--fixed", "--state", state] }).stdout).toContain("back");
      expect(findings(run({ args: [f, "--state", state, "--json"] }))[0]).toMatchObject({ judgement: "back", backCount: 1 });
    });

    it("mark for a finding that is not there yet says so, exits 0 and keeps the mark", () => {
      const state = join(dir, "early.json");
      const m = run({ args: ["mark", "deadbeef", "--known", "later", "--state", state] });
      expect(m.status).toBe(0);
      expect(m.stderr).toMatch(/no finding with that id/);
      expect(JSON.parse(readFileSync(state, "utf8")).marks).toEqual([{ id: "deadbeef", known: "later" }]);
    });

    it("the id mark takes is the one the table prints", () => {
      const state = join(dir, "table-id.json");
      const id = /^new\s+5\s+([0-9a-f]{8})\s/m.exec(run({ args: [f, "--state", state] }).stdout)?.[1] ?? "";
      expect(run({ args: ["mark", id, "--known", "x", "--state", state] })).toMatchObject({ status: 0, stderr: "" });
      expect(findings(run({ args: [f, "--state", state, "--json"] }))[0]).toMatchObject({ id, judgement: "known" });
    });

    it("a run is one batch and a mark is none: one entry in the counts per run", () => {
      const state = join(dir, "batches.json");
      const { id } = judged(state);
      const counts = (): number[] => JSON.parse(readFileSync(state, "utf8")).groups[0].counts;
      expect(counts()).toEqual([5]);
      expect(run({ args: ["mark", id, "--known", "x", "--state", state] }).status).toBe(0);
      expect(counts()).toEqual([5]);
      judged(state);
      expect(counts()).toEqual([5, 5]);
    });

    it("a state that cannot be written is said, not hidden: 2 for a mark, which is nothing else", () => {
      const r = run({ args: [f, "--state", join(dir, "missing-dir", "a", "s.json", "x", "y")] });
      expect(r.status).toBe(0);
      const blocked = file("blocked.txt", "i am a file");
      expect(run({ args: [f, "--state", join(blocked, "s.json")] })).toMatchObject({ status: 2, stdout: "", stderr: expect.stringContaining("ENOTDIR") });
      if (process.getuid?.() === 0) return; // root writes anywhere
      const readOnly = join(dir, "read-only");
      mkdirSync(readOnly);
      chmodSync(readOnly, 0o555);
      const run1 = run({ args: [f, "--state", join(readOnly, "s.json")] });
      expect(run1).toMatchObject({ status: 0, stderr: expect.stringContaining("state file could not be written") });
      const mark = run({ args: ["mark", "deadbeef", "--fixed", "--state", join(readOnly, "s.json")] });
      expect(mark).toMatchObject({ status: 2, stdout: "", stderr: expect.stringContaining("state file could not be written") });
      chmodSync(readOnly, 0o755);
    });

    it("never writes over a file that is not a state: the log itself, other JSON, a link, a state of a later version", () => {
      const log = file("my.log", "2026-11-24T10:00:00Z ERROR boom\n");
      const json = file("package.json", '{"name":"shop","version":"1.0.0"}');
      const later = file("later.json", '{"version":2,"groups":[]}');
      const link = join(dir, "link.json");
      symlinkSync(json, link);
      for (const [args, path] of [[[log, "--state", log], log], [[log, "--state", json], json], [[log, "--state", link], json], [[log, "--state", later], later], [["mark", "deadbeef", "--fixed", "--state", json], json], [[log, "--state", dir], log]] as Array<[string[], string]>) {
        const was = readFileSync(path, "utf8");
        const r = run({ args });
        expect(r.status, args.join(" ")).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(/not written over|is not a file/);
        expect(readFileSync(path, "utf8")).toBe(was);
      }
      const empty = file("empty.json", "");
      expect(run({ args: [log, "--state", empty] }).status).toBe(0);
      expect(JSON.parse(readFileSync(empty, "utf8"))).toMatchObject({ version: 1 });
    });
  });

  describe("the filters", () => {
    const log = file("filters.log", ["2026-11-24T10:00:00Z WARN disk at 91 percent", "2026-11-24T10:00:01Z ERROR job 7 failed", "2026-11-24T10:00:02Z ERROR job 8 failed", "2026-11-24T10:00:03Z DEBUG chatter"].join("\n"));
    const titles = (extra: string[]): string[] => findings(run({ args: [log, "--json", ...extra] })).map((x) => x.title as string).sort();
    it("--level, --noise, --service, --release, --min-status, --top and --format=value", () => {
      expect(titles([])).toEqual(["disk at # percent", "job # failed"]);
      expect(titles(["--level", "error"])).toEqual(["job # failed"]);
      expect(titles(["--level=debug"])).toHaveLength(3);
      expect(findings(run({ args: [log, "--json", "--noise", "disk", "--noise", "nothing"] })).find((x) => x.title === "disk at # percent")?.judgement).toBe("noise");
      const f = findings(run({ args: [log, "--json", "--service", "shop", "--release", "r9"] }))[0];
      expect(f).toMatchObject({ service: "shop", releases: ["r9"] });
      const access = file("status.log", ['1.1.1.1 - - [24/Nov/2026:10:00:00 +0000] "GET /a HTTP/1.1" 404 0 "-" "x"', '1.1.1.1 - - [24/Nov/2026:10:00:00 +0000] "GET /b HTTP/1.1" 503 0 "-" "x"'].join("\n"));
      expect(findings(run({ args: [access, "--json", "--min-status", "500"] }))).toHaveLength(1);
      const many = file("many.log", Array.from({ length: 30 }, (_, i) => `ERROR distinct failure kind${"x".repeat(i)}y`).join("\n"));
      expect(run({ args: [many, "--top", "3"] }).stdout).toMatch(/… 27 more/);
      expect(run({ args: [many, "--format=text", "--top=2"] }).stdout.split("\n").length).toBeLessThan(8);
    });
  });

  describe("nothing is sent without --cloud", () => {
    let server: Server;
    let hits: string[] = [];
    let dsn = "";
    let answer: number | "none" = 200;
    let body = "{}";
    beforeAll(async () => {
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          hits.push(raw);
          if (answer === "none") return;
          res.writeHead(answer, { "content-type": "application/json" });
          res.end(body);
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      dsn = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/overseer`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    it("with the key and the endpoint in the environment but no --cloud, nothing is sent and no socket is opened", () => {
      hits = [];
      const r = run({ args: [join(example, "app.json.jsonl"), "--json"], env: { CODMIR_CLIENT_KEY: "osk_testkey0123456789", CODMIR_DSN: dsn } });
      expect(r.status).toBe(0);
      expect(findings(r)).toHaveLength(1);
      expect(hits).toEqual([]);
      expect(attempts()).toBe("");
    });

    it("with --cloud the findings are sent to the project, redacted, and the command waits for it", async () => {
      hits = [];
      const r = await runAsync([join(example, "app.json.jsonl"), "--cloud"], { CODMIR_CLIENT_KEY: "osk_testkey0123456789", CODMIR_DSN: dsn });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/sent 1 finding to Codmir/);
      // The server answered after the child ended only if the command did not wait: hits must be there by now.
      expect(hits).toHaveLength(1);
      const body = JSON.parse(hits[0]) as { events: Array<{ event: { message?: string } }> };
      expect(JSON.stringify(body)).toContain("report failed for user");
      expect(hits[0]).not.toContain("sk_live");
    });

    const send = (args: string[], to = dsn): ReturnType<typeof runAsync> => runAsync([...args, "--cloud"], { CODMIR_CLIENT_KEY: "osk_testkey0123456789", CODMIR_DSN: to });
    const bug = join(example, "app.json.jsonl");

    it("says what Codmir did not take, with the reason, and exits 2", async () => {
      try {
        answer = 401;
        expect(await send([bug])).toMatchObject({ status: 2, stdout: expect.stringContaining("sent 0 findings to Codmir\n"), stderr: "codmir-logs: Codmir did not take 1 finding: status 401\n" });
        answer = 200;
        body = JSON.stringify({ droppedEvents: [{ index: 0, reason: "payment_required\u001b[31m" }] });
        expect(await send([bug])).toMatchObject({ status: 2, stdout: expect.stringContaining("sent 0 findings to Codmir\n"), stderr: "codmir-logs: Codmir did not take 1 finding: payment_required\n" });
        const json = await send([bug, "--json"]);
        expect(json.status).toBe(2);
        expect(JSON.parse(json.stdout).cloud).toMatchObject({ sent: 1, refused: 1, waiting: 0 });
      } finally {
        answer = 200;
        body = "{}";
      }
    });

    it("says that nobody answered, and does not wait for minutes for it", async () => {
      expect(await send([bug], "http://127.0.0.1:1/api/overseer")).toMatchObject({ status: 2, stderr: "codmir-logs: no answer from Codmir for 1 finding\n" });
      try {
        answer = "none";
        const t0 = Date.now();
        expect(await send([bug])).toMatchObject({ status: 2, stdout: expect.stringContaining("sent 0 findings to Codmir\n"), stderr: "codmir-logs: no answer from Codmir for 1 finding\n" });
        expect(Date.now() - t0).toBeLessThan(15_000);
      } finally {
        answer = 200;
      }
    }, 30_000);

    it("says how many findings were over the limit of a run", async () => {
      const many = file("over.log", Array.from({ length: 55 }, (_, i) => `2026-11-24T10:00:00Z ERROR failure of kind ${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"xyz"[Math.floor(i / 26)]}`).join("\n"));
      expect((await send([many])).stdout).toContain("sent 50 findings to Codmir; 5 over the limit of a run\n");
    });
  });

  describe("nothing a line holds reaches the screen, the state or the cloud raw", () => {
    it("removes escape sequences and control characters from a title, a sample, a service and a release", () => {
      const evil = "\u001b]0;pwned\u0007\u001b[31mred\u001b[0m\u001b[2J \u009b31m \u0007bell ‮evil‬ done\r\nline two";
      const log = file("evil.jsonl", [1, 2, 3].map((i) => JSON.stringify({ level: "error", msg: `boom ${evil} ${i}`, service: `svc${evil}`, release: `r${evil}`, time: 1795514400000 + i })).join("\n"));
      const table = run({ args: [log] });
      expect(table.stdout).toContain("boom");
      expect(table.stdout).toContain("red");
      expect(table.stdout.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
      const json = run({ args: [log, "--json", "--service", evil] });
      expect(json.stdout.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
      expect(json.stdout).not.toContain("\\u001b");
      expect(table.stderr + json.stderr).toBe("");
    });

    it("removes them from a file name, in an error and in a mark", () => {
      const name = "a\u001b[31m\u001b]0;pwned\u0007b.log";
      const missing = run({ args: [join(dir, name)] });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("ENOENT");
      expect(missing.stderr.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
      const real = file(name, "ERROR boom 1\nERROR boom 2\n");
      const ok = run({ args: [real, "--format", "text"] });
      expect(ok.status).toBe(0);
      expect(ok.stdout.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
      const m = run({ args: ["mark", "id\u001b[2J\u001b]0;x\u0007", "--known", "n\u001b[31m", "--state", join(dir, "evil-state.json")] });
      expect(m.stdout.replace(/\n/g, "") + m.stderr.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
      expect(m.stdout).toContain("marked id as known");
      const bad = run({ args: ["--format", "x\u001b[2J"] });
      expect(bad.stderr.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
      const flag = run({ args: ["--\u001b[2Jflag"] });
      expect(flag.stderr.replace(/\n/g, "")).not.toMatch(SCREEN_BAD);
    });

    it("prints colour only on a terminal and only when NO_COLOR is unset", async () => {
      const io = (tty: boolean, env: Record<string, string>): { out: () => string; io: Parameters<typeof main>[1] } => {
        let out = "";
        return { out: () => out, io: { stdin: process.stdin, stdout: { write: (s: string) => void (out += s), isTTY: tty }, stderr: { write: () => undefined }, env } };
      };
      const log = join(example, "access.log");
      const tty = io(true, {});
      await main([log], tty.io);
      expect(tty.out()).toContain("\u001b[31m");
      const noColor = io(true, { NO_COLOR: "1" });
      await main([log], noColor.io);
      expect(noColor.out()).not.toContain("\u001b");
      const piped = io(false, {});
      await main([log], piped.io);
      expect(piped.out()).not.toContain("\u001b");
    });

    // What a log can hold, in every format, wherever the format has room for it.
    // A deployment id is a name (`dpl_` + letters and digits stays); a mixed-case run behind it cannot be told from one, so it is not planted there.
    const shaped = ["jane.doe@example.com", "10.1.2.3", "2001:db8::7", "sk-live_ABCdef1234567890xyz", "ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123", "abcDEF123456ghiJKL789mnopq", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4", "4242424242424242"];
    const named = ["hunter2secret", "s3cr3tcookie", "SECRETQUERY"];
    const secrets = [...shaped, ...named];
    let seed = 4242;
    const rnd = (n: number): number => Math.floor(((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * n);
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)];
    const wrapAny = [(s: string) => s, (s: string) => `token=${s}`, (s: string) => `Bearer ${s}`, (s: string) => `user ${s} failed`, (s: string) => `api_key: ${s}`];
    const wrapNamed = [(s: string) => `token=${s}`, (s: string) => `password: ${s}`, (s: string) => `api_key: ${s}`];
    const piece = (): string => {
      const useNamed = rnd(4) === 0;
      return (useNamed ? pick(wrapNamed) : pick(wrapAny))(useNamed ? pick(named) : pick(shaped));
    };
    const T = (i: number): number => 1795514400000 + i * 1000;
    const GENERATORS: Record<string, (i: number) => string> = {
      json: (i) => (i % 2 ? JSON.stringify({ level: "error", time: T(i), msg: `step ${i % 7} failed ${piece()}`, service: `svc-${pick(shaped)}`, release: `r-${pick(shaped)}` }) : JSON.stringify({ method: "POST", url: `https://u:${pick(named)}@h.example/api/${pick(shaped)}/x?k=${pick(shaped)}#${pick(shaped)}`, status: 500, time: T(i), userAgent: `Mozilla/5.0 ${pick(secrets)}` })),
      pino: (i) => (i % 2 ? JSON.stringify({ level: 50, time: T(i), msg: `job ${i % 5} failed`, err: { type: "Error", message: piece() } }) : JSON.stringify({ level: 50, time: T(i), req: { method: "GET", url: `/u/${pick(shaped)}?t=${pick(shaped)}#${pick(shaped)}`, headers: { "user-agent": pick(secrets) } }, res: { statusCode: 502 } })),
      vercel: (i) => (i % 3 === 0 ? JSON.stringify({ type: "log", data: { timestamp: T(i), level: "error", source: "lambda", message: `crash ${i % 3} ${piece()}`, requestPath: `/p/${pick(shaped)}?q=${pick(shaped)}`, environment: `env-${pick(shaped)}`, deploymentId: `dpl_${pick(shaped.filter((x) => x !== "abcDEF123456ghiJKL789mnopq"))}` } }) : i % 3 === 1 ? JSON.stringify({ type: "request", data: { timestamp: T(i), requestMethod: "GET", requestPath: `/r/${pick(shaped)}#${pick(shaped)}`, httpStatus: 500, clientUserAgent: pick(secrets), requestHostname: pick(shaped) } }) : JSON.stringify({ id: `i${i}`, timestamp: T(i), level: "error", message: piece(), source: "edge", host: pick(shaped), proxy: { method: "GET", path: `/d/${pick(shaped)}?a=${pick(shaped)}`, statusCode: 503, userAgent: [pick(secrets)] }, statusCode: 503 })),
      railway: (i) => JSON.stringify({ timestamp: new Date(T(i)).toISOString(), severity: "error", message: `rw ${i % 4} ${piece()}`, attributes: { level: "error", ...(i % 2 ? { method: "GET", path: `/x/${pick(shaped)}#${pick(shaped)}`, status: 500 } : {}) } }),
      journald: (i) => JSON.stringify({ PRIORITY: "3", MESSAGE: i % 2 ? `unit ${i % 5} failed ${piece()}` : JSON.stringify({ level: "error", msg: `inner ${i % 3} ${piece()}` }), __REALTIME_TIMESTAMP: String(T(i) * 1000), _SYSTEMD_UNIT: `u${i % 3}-${pick(shaped)}.service`, SYSLOG_IDENTIFIER: `id-${pick(shaped)}` }),
      clf: (i) => `${pick(["10.1.2.3", "203.0.113.9", "2001:db8::7", "pc-7731.dialup.example.net"])} - ${pick(["jane.doe@example.com", "frank"])} [24/Nov/2026:10:00:${String(i % 60).padStart(2, "0")} +0000] "GET /f/${pick(shaped)}?t=${pick(shaped)}#${pick(shaped)} HTTP/1.1" 500 12 "https://r.example/?k=${pick(shaped)}" "Mozilla/5.0 ${pick(secrets)}"`,
      text: (i) => `2026-11-24T10:00:${String(i % 60).padStart(2, "0")}Z ERROR step ${i % 6} failed ${piece()}`,
      logfmt: (i) => `time="2026-11-24T10:00:${String(i % 60).padStart(2, "0")}Z" level=error msg="step ${i % 6} failed ${piece()}" svc=${pick(shaped)}`,
    };

    for (const [format, make] of Object.entries(GENERATORS)) {
      it(`${format}: none of ${secrets.length} made-up secrets, placed at random in 300 lines, reaches the screen, the state or the cloud`, async () => {
        const lines = Array.from({ length: 300 }, (_, i) => make(i));
        const path = file(`secrets-${format}.log`, `${lines.join("\n")}\n`);
        const state = join(dir, `secrets-${format}.json`);
        const hits: string[] = [];
        const server = createServer((req, res) => {
          let raw = "";
          req.on("data", (c) => (raw += c));
          req.on("end", () => {
            hits.push(raw);
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          });
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/overseer`;
        try {
          const f = format === "logfmt" ? "text" : format;
          const r = await runAsync([path, "--format", f, "--state", state, "--top", "1000", "--cloud"], { CODMIR_CLIENT_KEY: "osk_testkey0123456789", CODMIR_DSN: url });
          expect(r.status, r.stderr).toBe(0);
          const json = run({ args: [path, "--format", f, "--state", state, "--json", "--top", "1000"] });
          const everything = { table: r.stdout, json: json.stdout, state: readFileSync(state, "utf8"), cloud: hits.join("\n") };
          expect(findings(json).length, "there are findings to hold secrets").toBeGreaterThan(0);
          expect(hits.length, "something was sent").toBeGreaterThan(0);
          for (const [where, text] of Object.entries(everything)) {
            for (const s of secrets) expect(text, `${where} holds ${s}`).not.toContain(s);
            expect(text, `${where} holds a query`).not.toMatch(/\?(?:t|k|q|a)=/);
          }
          // The address of a client of an access log is not kept in any form.
          for (const text of Object.values(everything)) expect(text).not.toMatch(/10\.1\.2\.3|203\.0\.113\.9|2001:db8|dialup/);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        }
      }, 60_000);
    }
  });

  describe("--follow, Ctrl-C and a closed pipe", () => {
    it("prints the first batch, goes on with what is appended, and on SIGINT prints a last batch and exits 0", async () => {
      const p = file("live.log", "2026-11-24T10:00:00Z ERROR first problem 1\n2026-11-24T10:00:01Z ERROR first problem 2\n");
      const child = spawn(process.execPath, [cli, p, "--follow", "--json"], { env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d));
      child.stderr.on("data", (d: Buffer) => (stderr += d));
      const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
      const until = async (cond: () => boolean, what: string): Promise<void> => {
        for (let i = 0; !cond(); i++) {
          if (i > 400) throw new Error(`timed out waiting for ${what}\n${stdout}\n${stderr}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      await until(() => stdout.includes("\n"), "the first batch");
      expect(JSON.parse(stdout.split("\n")[0])).toMatchObject({ findings: [{ title: "first problem #", hits: 2 }] });
      writeFileSync(p, "2026-11-24T10:00:00Z ERROR first problem 1\n2026-11-24T10:00:01Z ERROR first problem 2\n2026-11-24T10:05:00Z ERROR second problem appended\n");
      await new Promise((r) => setTimeout(r, 2500));
      child.kill("SIGINT");
      expect(await exited).toBe(0);
      const batches = stdout.trim().split("\n").map((l) => JSON.parse(l) as { findings: Array<{ title: string }>; read: { lines: number } });
      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches.at(-1)?.findings.map((x) => x.title)).toEqual(["second problem appended"]);
      expect(batches.at(-1)?.read.lines).toBe(3);
      expect(stderr).toBe("");
    }, 30_000);

    it("a closed pipe (| head -1) ends quietly", () => {
      const lines = Array.from({ length: 4000 }, (_, i) => `2026-11-24T10:00:00Z ERROR distinct failure ${"w".repeat(i % 50)}${String.fromCharCode(97 + (i % 26))}${"z".repeat(Math.floor(i / 26))} end`).join("\n");
      const big = file("many-findings.log", lines);
      const errFile = join(dir, "pipe-err.txt");
      const r = spawnSync("sh", ["-c", `"$0" "$1" "$2" --top 100000 --format text 2>"$3" | head -n 1; echo "codes: $(cat "$3" | wc -c)"`, process.execPath, cli, big, errFile], { encoding: "utf8", timeout: 30_000 });
      expect(r.status).toBe(0);
      const [first, codes] = r.stdout.trimEnd().split("\n");
      expect(first).toMatch(/^JUDGED/);
      expect(codes).toBe("codes: 0");
    });
  });
});

describe("the command without a build", () => {
  it("is skipped when dist is missing (CI runs it again after the build)", () => {
    expect(typeof hasDist).toBe("boolean");
  });
});
