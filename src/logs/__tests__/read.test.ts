import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readLog, type ReadResult } from "../node";
import type { LogRecord, RequestRecord } from "../types";
import { bundle, scratch } from "./helpers";

const dir = scratch("read");

/** A sink that keeps what it is given. */
const sink = (): { record(r: LogRecord): void; request(r: RequestRecord): void; got: Array<LogRecord | RequestRecord> } => {
  const got: Array<LogRecord | RequestRecord> = [];
  return { got, record: (r) => void got.push(r), request: (r) => void got.push(r) };
};

// 3 KB of lines with multi-byte characters, both line endings, JSON and text.
const LINES = Array.from({ length: 40 }, (_, i) =>
  i % 3 === 0 ? `{"level":"error","msg":"café ${i} 日本語 😀 ünï"}` : i % 3 === 1 ? `2026-11-24 10:00:${String(i).padStart(2, "0")} WARN naïve ${i} — dash 🙂 ${"x".repeat(i)}` : `203.0.113.${i} - - [24/Nov/2026:10:00:00 +0000] "GET /é/${i} HTTP/1.1" 50${i % 10} 5`,
);
const FILE = Buffer.from(LINES.map((l, i) => l + (i % 2 ? "\r\n" : "\n")).join(""));

describe("readLog: lines across chunk borders", () => {
  it("is the same as one chunk when the file is cut at every byte", async () => {
    expect(FILE.length).toBeGreaterThan(2500);
    const whole = sink();
    const r0 = await readLog(Readable.from([FILE], { objectMode: false }), whole);
    expect(r0.lines).toBe(40);
    expect(whole.got).toHaveLength(40);
    for (let k = 1; k < FILE.length; k++) {
      const s = sink();
      const r = await readLog(Readable.from([FILE.subarray(0, k), FILE.subarray(k)], { objectMode: false }), s);
      expect(r, `cut at ${k}`).toEqual(r0);
      expect(s.got, `cut at ${k}`).toEqual(whole.got);
    }
  });

  it("is the same with three cuts, with one byte per chunk, and when the chunks are strings", async () => {
    const whole = sink();
    await readLog(Readable.from([FILE], { objectMode: false }), whole);
    const bytes = sink();
    await readLog(Readable.from(Array.from(FILE, (b) => Buffer.from([b])), { objectMode: false }), bytes);
    expect(bytes.got).toEqual(whole.got);
    const strings = sink();
    await readLog((async function* () { yield FILE.toString("utf8", 0, 1000); yield FILE.toString("utf8", 1000); })(), strings);
    expect(strings.got.length).toBe(40);
  });

  it("splits \\r\\n, counts a last line without a newline, ignores a final newline and keeps blank lines as skipped", async () => {
    const s = sink();
    const r = await readLog(Readable.from([Buffer.from("ERROR a\r\n\r\nERROR b\nERROR c")], { objectMode: false }), s);
    expect(r).toEqual({ lines: 4, records: 3, requests: 0, skipped: 1, bytes: 26 });
    expect(s.got.map((x) => (x as LogRecord).message)).toEqual(["a", "b", "c"]);
    const t = await readLog(Readable.from([Buffer.from("ERROR a\n")], { objectMode: false }), sink());
    expect(t.lines).toBe(1);
  });

  it("takes a byte order mark off the first line", async () => {
    const s = sink();
    await readLog(Readable.from([Buffer.from('﻿{"level":"error","msg":"m"}\n')], { objectMode: false }), s);
    expect(s.got).toEqual([{ level: "error", message: "m" }]);
  });

  it("cuts a line over 64 KB to its start and does not keep the rest", async () => {
    const s = sink();
    const chunks = (async function* () {
      yield Buffer.from("ERROR start ");
      for (let i = 0; i < 100; i++) yield Buffer.from("y".repeat(10_000));
      yield Buffer.from("\nERROR next\n");
    })();
    const r = await readLog(chunks, s);
    expect(r.lines).toBe(2);
    expect((s.got[0] as LogRecord).message.startsWith("start yyyy")).toBe(true);
    expect((s.got[1] as LogRecord).message).toBe("next");
  });

  it("counts a JSON array of objects as one line and several records or requests", async () => {
    const s = sink();
    const r = await readLog(Readable.from([Buffer.from('[{"level":"error","msg":"a"},{"method":"GET","path":"/x","status":500}]\n')], { objectMode: false }), s);
    expect(r).toMatchObject({ lines: 1, records: 1, requests: 1, skipped: 0 });
  });

  it("reads with the format it is given", async () => {
    const s = sink();
    await readLog(Readable.from([Buffer.from('{"PRIORITY":"3","MESSAGE":"disk"}\n')], { objectMode: false }), s, { format: "journald" });
    expect(s.got).toEqual([{ level: "error", message: "disk", service: undefined }].map((x) => ({ level: x.level, message: x.message })));
  });
});

describe("readLog: files and gzip", () => {
  const text = "ERROR one\n2026-11-24T10:00:00Z WARN two\n";

  it("reads a path", async () => {
    const f = join(dir, "plain.log");
    writeFileSync(f, text);
    const s = sink();
    expect(await readLog(f, s)).toEqual({ lines: 2, records: 2, requests: 0, skipped: 0, bytes: text.length });
  });

  it("unpacks a gzip file by its first bytes, whatever its name", async () => {
    const gz = gzipSync(Buffer.from(text.repeat(500)));
    for (const name of ["a.log.gz", "a.log", "a"]) {
      const f = join(dir, name);
      writeFileSync(f, gz);
      const r = await readLog(f, sink());
      expect(r, name).toMatchObject({ lines: 1000, records: 1000, bytes: gz.length });
    }
  });

  it("does not unpack a plain file named .gz, and unpacks a gzip stream, in chunks of one byte", async () => {
    const f = join(dir, "plain.gz");
    writeFileSync(f, text);
    expect((await readLog(f, sink())).lines).toBe(2);
    const gz = gzipSync(Buffer.from(text));
    const r = await readLog(Readable.from(Array.from(gz, (b) => Buffer.from([b])), { objectMode: false }), sink());
    expect(r.lines).toBe(2);
  });

  it("reads concatenated gzip members and keeps what it could unpack of a cut one", async () => {
    const two = Buffer.concat([gzipSync(Buffer.from("ERROR a\n")), gzipSync(Buffer.from("ERROR b\n"))]);
    expect((await readLog(Readable.from([two], { objectMode: false }), sink())).lines).toBe(2);
    const big = gzipSync(Buffer.from("ERROR line\n".repeat(20_000)));
    const cutOff = big.subarray(0, Math.floor(big.length * 0.8));
    const r = await readLog(Readable.from([cutOff], { objectMode: false }), sink());
    expect(r.lines).toBeGreaterThan(1000);
  });

  it("rejects a corrupt gzip stream, a missing file and a folder", async () => {
    const bad = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.from("not really gzip at all, no")]);
    await expect(readLog(Readable.from([bad], { objectMode: false }), sink())).rejects.toThrow();
    await expect(readLog(join(dir, "missing.log"), sink())).rejects.toMatchObject({ code: "ENOENT" });
    mkdirSync(join(dir, "folder"), { recursive: true });
    await expect(readLog(join(dir, "folder"), sink())).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("rejects what the source throws", async () => {
    const bad = (async function* () {
      yield Buffer.from("ERROR a\n");
      throw new Error("the source broke");
    })();
    await expect(readLog(bad, sink())).rejects.toThrow("the source broke");
  });
});

describe("readLog: abort and back-pressure", () => {
  it("resolves with what was read when the signal fires, even if the source is waiting for more", async () => {
    const c = new AbortController();
    const s = sink();
    const waiting = (async function* () {
      yield Buffer.from("ERROR a\nERROR b\n");
      await new Promise(() => undefined); // a pipe with nobody writing
    })();
    const p = readLog(waiting, s, { signal: c.signal });
    setTimeout(() => c.abort(), 30);
    const r = await p;
    expect(r).toMatchObject({ aborted: true, lines: 2, records: 2 });
  });

  it("returns at once for a signal that is already aborted, and reads nothing", async () => {
    const c = new AbortController();
    c.abort();
    let pulled = 0;
    const src = (async function* () { pulled++; yield Buffer.from("ERROR a\n"); })();
    expect(await readLog(src, sink(), { signal: c.signal })).toMatchObject({ aborted: true, lines: 0 });
    expect(pulled).toBe(0);
  });

  it("stops a fast source that never leaves the microtask queue", async () => {
    const c = new AbortController();
    let made = 0;
    const endless = (async function* () {
      for (;;) {
        made++;
        yield Buffer.from("ERROR a\n".repeat(100));
      }
    })();
    setTimeout(() => c.abort(), 30);
    const r = await readLog(endless, sink(), { signal: c.signal });
    expect(r.aborted).toBe(true);
    expect(made).toBeGreaterThan(10);
  });

  it("asks for the next chunk only when the last one is done: a stream is never far ahead of the reader", async () => {
    let pushed = 0;
    let seen = 0;
    let maxAhead = 0;
    const chunk = Buffer.from("ERROR something failed with a fairly long text here\n".repeat(1000));
    const stream = new Readable({
      highWaterMark: chunk.length,
      read() {
        if (pushed >= 400) return void this.push(null);
        pushed++;
        this.push(chunk);
      },
    });
    const probe = { record: () => void (seen++, (maxAhead = Math.max(maxAhead, pushed - Math.floor(seen / 1000)))), request: () => undefined };
    const r = await readLog(stream, probe);
    expect(r.lines).toBe(400_000);
    // The stream buffers one chunk beyond the one being read, never the whole source.
    expect(maxAhead).toBeLessThanOrEqual(4);
  });
});

describe("readLog: a large stream", () => {
  // 200 MB of generated lines of 1,000 shapes into a real monitor, in a child process whose heap is capped at 64 MB (a
  // reader that kept the lines would die) and which measures the heap after a collection at 40 MB and at the end.
  const MB = 200;
  it(`holds flat memory over ${MB} MB`, async () => {
    const nodeJs = await bundle("src/logs/node.ts", dir, "read-node");
    const logsJs = await bundle("src/logs/index.ts", dir, "read-logs");
    const script = join(dir, "big.mjs");
    writeFileSync(
      script,
      `import { createLogMonitor } from ${JSON.stringify(logsJs)};
import { readLog } from ${JSON.stringify(nodeJs)};
const MB = ${MB};
const m = createLogMonitor({ batchMinutes: 10080 });
const line = (i) =>
  i % 5 === 0 ? \`{"level":"error","time":\${1795514400000 + i},"msg":"worker \${i % 1000} failed on job \${i} with code \${i % 97}","service":"w\${i % 7}"}\\n\`
  : i % 5 === 1 ? \`{"method":"GET","path":"/items/\${i}/part\${i % 1000}","status":\${i % 13 === 0 ? 500 : 200},"durationMs":\${i % 300}}\\n\`
  : i % 5 === 2 ? \`2026-11-24T10:00:00Z INFO request \${i} handled in \${i % 50} ms for user-\${i % 1000} and some padding to make the line longer\\n\`
  : i % 5 === 3 ? \`203.0.113.\${i % 250} - - [24/Nov/2026:10:00:00 +0000] "GET /static/file\${i % 1000}.js HTTP/1.1" 304 0 "-" "Mozilla/5.0"\\n\`
  : \`{"level":30,"time":\${1795514400000 + i},"msg":"tick \${i}","req":{"method":"POST","url":"/api/v\${i % 3}/things/\${i}"},"res":{"statusCode":\${i % 41 === 0 ? 503 : 201}}}\\n\`;
let chunks = 0, produced = 0, baseline = 0, peak = 0, rssBase = 0, rssPeak = 0;
const src = (async function* () {
  let i = 0, buf = "";
  while (produced < MB * 1024 * 1024) {
    buf += line(i++);
    if (buf.length > 256 * 1024) {
      produced += buf.length;
      yield Buffer.from(buf);
      buf = "";
      if (++chunks % 20 === 0) {
        global.gc();
        const u = process.memoryUsage();
        if (!baseline && produced > 40 * 1024 * 1024) { baseline = u.heapUsed; rssBase = u.rss; }
        if (baseline) { peak = Math.max(peak, u.heapUsed); rssPeak = Math.max(rssPeak, u.rss); }
      }
    }
  }
})();
const t0 = Date.now();
const r = await readLog(src, m);
await m.stop();
console.log(JSON.stringify({ ...r, seconds: (Date.now() - t0) / 1000, baseline, peak, rssBase, rssPeak }));
`,
    );
    const res = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=64", script], { encoding: "utf8", timeout: 170_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as ReadResult & { seconds: number; baseline: number; peak: number; rssBase: number; rssPeak: number };
    expect(out.bytes).toBeGreaterThanOrEqual(MB * 1024 * 1024);
    expect(out.lines).toBeGreaterThan(1_000_000);
    expect(out.records + out.requests).toBe(out.lines);
    expect(out.baseline).toBeGreaterThan(0);
    // 160 MB more input: the heap after a collection grew by under 8 MB, and the resident size by under 48 MB.
    expect(out.peak - out.baseline, JSON.stringify(out)).toBeLessThan(8 * 1024 * 1024);
    expect(out.rssPeak - out.rssBase, JSON.stringify(out)).toBeLessThan(48 * 1024 * 1024);
    console.log(`${MB} MB: ${out.lines} lines in ${out.seconds.toFixed(1)} s, heap ${(out.baseline / 1e6).toFixed(1)} to ${(out.peak / 1e6).toFixed(1)} MB, resident ${(out.rssBase / 1e6).toFixed(0)} to ${(out.rssPeak / 1e6).toFixed(0)} MB`);
  }, 180_000);
});
