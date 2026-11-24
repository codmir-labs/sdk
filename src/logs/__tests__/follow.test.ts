import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { followFile, type Follower } from "../node";
import type { LogRecord, RequestRecord } from "../types";
import { bundle, scratch } from "./helpers";

const dir = scratch("follow");
let n = 0;
const fresh = (): string => join(dir, `f${n++}.log`);
const live: Follower[] = [];

const sink = (): { record(r: LogRecord): void; request(r: RequestRecord): void; messages: string[] } => {
  const messages: string[] = [];
  return { messages, record: (r) => void messages.push(r.message), request: (r) => void messages.push(`${r.method} ${r.path} ${r.status}`) };
};
const follow = (path: string, s: ReturnType<typeof sink>, from?: "end" | "start"): Follower => {
  const f = followFile(path, s, { from, intervalMs: 20 });
  live.push(f);
  return f;
};
const until = async (cond: () => boolean, what: string, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const quiet = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const f of live.splice(0)) await f.stop();
});

describe("followFile", () => {
  it("starts at the end: what was there is not read, what is appended is", async () => {
    const p = fresh();
    writeFileSync(p, "ERROR old one\nERROR old two\n");
    const s = sink();
    const f = follow(p, s);
    await f.ready;
    await quiet();
    expect(s.messages).toEqual([]);
    appendFileSync(p, "ERROR new one\n");
    await until(() => s.messages.length === 1, "the new line");
    appendFileSync(p, "ERROR new two\nERROR new three\n");
    await until(() => s.messages.length === 3, "two more lines");
    expect(s.messages).toEqual(["new one", "new two", "new three"]);
  });

  it("starts at the start with from: start, and ready says the backlog is read", async () => {
    const p = fresh();
    writeFileSync(p, "ERROR old one\nERROR old two\n");
    const s = sink();
    const f = follow(p, s, "start");
    await f.ready;
    expect(s.messages).toEqual(["old one", "old two"]);
    expect(f.counts()).toMatchObject({ lines: 2, records: 2, bytes: 28 });
  });

  it("waits for the end of a line: half of one is not read until its newline is written", async () => {
    const p = fresh();
    writeFileSync(p, "");
    const s = sink();
    follow(p, s, "start");
    appendFileSync(p, "ERROR half a li");
    await quiet(150);
    expect(s.messages).toEqual([]);
    appendFileSync(p, "ne\n");
    await until(() => s.messages.length === 1, "the whole line");
    expect(s.messages).toEqual(["half a line"]);
  });

  it("goes on after truncation (copy-truncate)", async () => {
    const p = fresh();
    writeFileSync(p, "ERROR a long first line that is longer than what follows\n");
    const s = sink();
    follow(p, s);
    appendFileSync(p, "ERROR before\n");
    await until(() => s.messages.length === 1, "the line before");
    truncateSync(p, 0);
    await quiet(80);
    appendFileSync(p, "ERROR after\n");
    await until(() => s.messages.length === 2, "the line after the truncation");
    expect(s.messages).toEqual(["before", "after"]);
  });

  it("goes on after a rotation by rename: reads the end of the old file, then the new one from its start", async () => {
    const p = fresh();
    writeFileSync(p, "ERROR first\n");
    const s = sink();
    follow(p, s);
    appendFileSync(p, "ERROR old 1\n");
    await until(() => s.messages.length === 1, "old 1");
    appendFileSync(p, "ERROR old 2 written just before the rotation\n");
    renameSync(p, `${p}.1`);
    writeFileSync(p, "ERROR new 1\nERROR new 2\n");
    await until(() => s.messages.length === 4, "old 2 and both new lines");
    expect(s.messages).toEqual(["old 1", "old 2 written just before the rotation", "new 1", "new 2"]);
    appendFileSync(p, "ERROR new 3\n");
    await until(() => s.messages.length === 5, "a line in the new file");
  });

  it("waits for a file that does not exist yet and reads it from its start; and for one that went away and came back", async () => {
    const p = fresh();
    const s = sink();
    follow(p, s);
    await quiet(80);
    writeFileSync(p, "ERROR born 1\n");
    await until(() => s.messages.length === 1, "the new file");
    unlinkSync(p);
    await quiet(80);
    appendFileSync(p, "ERROR back 1\n");
    await until(() => s.messages.length === 2, "the file that came back");
    expect(s.messages).toEqual(["born 1", "back 1"]);
  });

  it("reads what is written after a missing file has come back many times", async () => {
    const p = fresh();
    const s = sink();
    follow(p, s);
    for (let i = 0; i < 5; i++) {
      writeFileSync(p, `ERROR round ${i}\n`);
      await until(() => s.messages.length === i + 1, `round ${i}`);
      unlinkSync(p);
      await quiet(60);
    }
    expect(s.messages).toHaveLength(5);
  });

  it("stop() ends it: nothing written later is read, and the file is closed", async () => {
    const p = fresh();
    writeFileSync(p, "");
    const s = sink();
    const f = follow(p, s, "start");
    appendFileSync(p, "ERROR one\n");
    await until(() => s.messages.length === 1, "one");
    await f.stop();
    appendFileSync(p, "ERROR two\n");
    await quiet(120);
    expect(s.messages).toEqual(["one"]);
    await f.stop(); // twice is fine
  });

  it("is for regular files: a folder (or anything else that is not one) is refused", () => {
    mkdirSync(join(dir, "afolder"), { recursive: true });
    expect(() => followFile(join(dir, "afolder"), sink())).toThrow(/regular file/);
  });

  it("never keeps the process alive and holds no watcher: a child that only follows a file exits by itself", async () => {
    const nodeJs = await bundle("src/logs/node.ts", dir, "follow-node");
    const p = fresh();
    writeFileSync(p, "ERROR x\n");
    const script = join(dir, "child.mjs");
    writeFileSync(script, `import { followFile } from ${JSON.stringify(nodeJs)};\nfollowFile(${JSON.stringify(p)}, { record() {}, request() {} }, { from: "start" });\nconsole.log("following");\n`);
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(process.execPath, [script], { env: { ...process.env, NODE_OPTIONS: "" } });
      let stdout = "";
      c.stdout.on("data", (d: Buffer) => (stdout += d));
      const t = setTimeout(() => c.kill("SIGKILL"), 8000);
      c.on("exit", (code) => {
        clearTimeout(t);
        resolve({ code, stdout });
      });
    });
    expect(out).toEqual({ code: 0, stdout: "following\n" });
  });
});
