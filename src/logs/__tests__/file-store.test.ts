import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogMonitor } from "../monitor";
import { fileStore, STORE_MAX_BYTES } from "../node";
import type { LogBatch, LogMonitor, LogMonitorOptions, LogState } from "../types";
import { bundle, root, scratch } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

const dir = scratch("file-store");
let n = 0;
/** A path no other test uses. */
const fresh = (name = "state.json"): string => join(dir, `case-${++n}`, name);

let monitors: LogMonitor[] = [];
let batches: LogBatch[] = [];
const make = (path: string, o: LogMonitorOptions = {}): LogMonitor => {
  const m = createLogMonitor({ onBatch: (b) => void batches.push(b), ...o, store: fileStore(path) });
  monitors.push(m);
  return m;
};
const at = (ms: number): void => void vi.setSystemTime(T0 + ms);
const err = (m: LogMonitor, message = "payment failed for order 8812"): void => m.record({ level: "error", message });
const judged = (): string[] => batches[batches.length - 1].findings.map((f) => f.judgement);
const mode = (path: string): number => statSync(path).mode & 0o777;
const left = (path: string): string[] => readdirSync(join(path, "..")).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  batches = [];
});
afterEach(async () => {
  for (const m of monitors) await m.stop();
  monitors = [];
  vi.useRealTimers();
});

describe("a restart through a real file, for each judgement", () => {
  it("new, then seen after the restart", async () => {
    const path = fresh();
    const first = make(path);
    err(first);
    await first.flush();
    expect(judged()).toEqual(["new"]);
    await first.stop();
    at(5 * MIN);
    const second = make(path);
    err(second);
    await second.flush();
    expect(judged()).toEqual(["seen"]);
  });

  it("back after a quiet day, and after a fixed mark", async () => {
    const path = fresh();
    const first = make(path);
    err(first);
    err(first, "queue stalled for tenant acme");
    await first.flush();
    first.mark(first.findings().find((f) => f.title.startsWith("queue"))!.id, { fixed: true });
    await first.stop();
    at(25 * HOUR);
    const second = make(path);
    err(second);
    err(second, "queue stalled for tenant acme");
    await second.flush();
    expect(batches[batches.length - 1].findings.map((f) => [f.title, f.judgement, f.backCount]).sort()).toEqual([["payment failed for order #", "back", 1], ["queue stalled for tenant acme", "back", 1]]);
  });

  it("known, with its note", async () => {
    const path = fresh();
    const first = make(path);
    err(first);
    await first.flush();
    first.mark(first.findings()[0].id, { known: "tracked in the wiki" });
    await first.stop();
    at(HOUR);
    const second = make(path);
    err(second);
    await second.flush();
    expect(batches[batches.length - 1].findings[0]).toMatchObject({ judgement: "known", known: "tracked in the wiki" });
  });

  it("alarm: 10 times its usual, with the history from the file", async () => {
    const path = fresh();
    const first = make(path);
    for (let i = 0; i < 4; i++) {
      at(i * 15 * MIN);
      err(first);
      await first.flush();
    }
    await first.stop();
    at(4 * 15 * MIN);
    const second = make(path);
    for (let i = 0; i < 10; i++) err(second);
    await second.flush();
    expect(judged()).toEqual(["alarm"]);
  });

  it("alarm: a 500 three times, and noise: a scanner probe, both stay what they are", async () => {
    const path = fresh();
    const first = make(path);
    for (let i = 0; i < 3; i++) first.request({ method: "GET", path: "/api/orders/42", status: 500 });
    first.request({ method: "GET", path: "/wp-login.php", status: 404, userAgent: "Mozilla/5.0" });
    await first.stop();
    at(MIN);
    const second = make(path);
    expect(Object.fromEntries(second.findings().map((f) => [f.title, f.judgement]))).toEqual({ "GET /api/orders/:n answers 500": "seen", "GET /wp-login.php answers 404": "noise" });
    for (let i = 0; i < 3; i++) second.request({ method: "GET", path: "/api/orders/42", status: 500 });
    await second.flush();
    expect(judged().sort()).toEqual(["alarm"]);
  });
});

describe("fileStore.save", () => {
  it("writes one whole JSON state with mode 0600, makes the folder, and leaves nothing else", async () => {
    const path = fresh(join("a", "b", "state.json"));
    const m = make(path);
    err(m);
    await m.flush();
    expect(mode(path)).toBe(0o600);
    const state = JSON.parse(readFileSync(path, "utf8")) as LogState;
    expect(state).toMatchObject({ version: 1, batchMinutes: 15, groups: [{ key: "error|payment failed for order #", total: 1 }] });
    await m.stop();
    for (let i = 0; i < 20; i++) m.mark("x", {});
    expect(left(path)).toEqual(["state.json"]);
  });

  it("makes the file 0600 whatever the umask of the process, and narrows a file that has wider rights", async () => {
    const path = fresh();
    const entry = await bundle("src/logs/node.ts", dir, "logs-node-umask");
    const script = join(dir, "umask.mjs");
    writeFileSync(script, `import { fileStore } from ${JSON.stringify(entry)};\nprocess.umask(0);\nfileStore(process.argv[2]).save({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups: [], marks: [], cloud: { day: "", sent: 0 } });\n`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "old", { mode: 0o644 });
    chmodSync(path, 0o666);
    const r = spawnSync(process.execPath, [script, path], { encoding: "utf8", timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(mode(path)).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    const fresher = fresh();
    expect(spawnSync(process.execPath, [script, fresher], { timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } }).status).toBe(0);
    expect(mode(fresher)).toBe(0o600);
  });

  it("a failed write leaves the old file whole and no temporary file", () => {
    const path = fresh();
    const store = fileStore(path);
    const state = (service: string): LogState => ({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups: [], marks: [{ id: service }], cloud: { day: "", sent: 0 } });
    store.save(state("first"));
    const folder = join(path, "..");
    chmodSync(folder, 0o500); // nothing can be made in it
    try {
      expect(() => store.save(state("second"))).toThrow();
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(JSON.parse(readFileSync(path, "utf8")).marks).toEqual([{ id: "first" }]);
    expect(left(path)).toEqual(["state.json"]);
  });

  it("a rename that fails (the path is a folder) removes the temporary file it made", () => {
    const path = fresh();
    mkdirSync(join(path, "inside"), { recursive: true });
    const store = fileStore(path);
    expect(() => store.save({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups: [], marks: [], cloud: { day: "", sent: 0 } })).toThrow();
    expect(left(path)).toEqual(["state.json"]); // only the folder that is the path itself
    expect(readdirSync(path)).toEqual(["inside"]);
  });

  it("through a monitor, a save into a folder that cannot be written is only an error", async () => {
    const path = fresh();
    const m = make(path);
    err(m);
    await m.flush();
    chmodSync(join(path, ".."), 0o500);
    try {
      err(m);
      await expect(m.flush()).resolves.toBeUndefined();
      expect(m.stats().errors).toBe(1);
    } finally {
      chmodSync(join(path, ".."), 0o700);
    }
    expect(JSON.parse(readFileSync(path, "utf8")).groups[0].total).toBe(1);
    expect(left(path)).toEqual(["state.json"]);
  });

  it("replaces a symbolic link at the path with a file, and leaves what it pointed to alone", () => {
    const path = fresh();
    const target = fresh("target.json");
    mkdirSync(join(path, ".."), { recursive: true });
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "precious");
    symlinkSync(target, path);
    fileStore(path).save({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups: [], marks: [], cloud: { day: "", sent: 0 } });
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(statSync(path).isFile()).toBe(true);
  });
});

describe("fileStore.load", () => {
  const good = (): string => {
    const path = fresh();
    const m = make(path);
    err(m);
    m.record({ level: "error", message: "second thing broke" });
    m.request({ method: "GET", path: "/users/42", status: 500, userAgent: "curl/8" });
    return path;
  };
  const saved = async (): Promise<string> => {
    const path = good();
    await monitors[monitors.length - 1].stop();
    return path;
  };
  const titles = (path: string): string[] => {
    const m = make(path);
    expect(m.stats().errors).toBe(0);
    return m.findings().map((f) => f.title).sort();
  };

  it("returns nothing for a file that is not there", () => {
    expect(fileStore(fresh()).load()).toBeUndefined();
    expect(titles(fresh())).toEqual([]);
  });

  it("reads a regular file only: a symbolic link, a folder, a device, a pipe give an empty start", async () => {
    const path = await saved();
    expect(titles(path)).toHaveLength(3);
    const link = fresh("link.json");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(path, link);
    expect(fileStore(link).load()).toBeUndefined();
    expect(titles(link)).toEqual([]);
    const folder = fresh("folder.json");
    mkdirSync(folder, { recursive: true });
    expect(fileStore(folder).load()).toBeUndefined();
    expect(fileStore("/dev/null").load()).toBeUndefined();
    expect(fileStore("/dev/zero").load()).toBeUndefined();
    const fifo = fresh("fifo.json");
    mkdirSync(join(fifo, ".."), { recursive: true });
    if (spawnSync("mkfifo", [fifo]).status === 0) expect(fileStore(fifo).load()).toBeUndefined();
  });

  it("reads at most 5 MB", async () => {
    const path = await saved();
    const size = statSync(path).size;
    writeFileSync(path, readFileSync(path, "utf8") + " ".repeat(STORE_MAX_BYTES - size));
    expect(statSync(path).size).toBe(STORE_MAX_BYTES);
    expect(titles(path)).toHaveLength(3);
    writeFileSync(path, readFileSync(path, "utf8") + " ");
    expect(statSync(path).size).toBe(STORE_MAX_BYTES + 1);
    expect(fileStore(path).load()).toBeUndefined();
    expect(titles(path)).toEqual([]);
  });

  it("starts empty on a file that is cut at every 100th byte, never throws, and loads the whole file", async () => {
    const path = fresh();
    const first = make(path);
    for (let g = 0; g < 40; g++) first.record({ level: "error", message: `failure of kind ${"abcdefghijklmnopqrstuvwxyz"[g % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(g / 26)]} happened` });
    await first.stop();
    const whole = readFileSync(path, "utf8");
    expect(JSON.parse(whole).groups).toHaveLength(40);
    const cut = fresh("cut.json");
    mkdirSync(join(cut, ".."), { recursive: true });
    let cuts = 0;
    for (let at = 0; at <= whole.length; at += 100) {
      writeFileSync(cut, whole.slice(0, at));
      const m = createLogMonitor({ store: fileStore(cut) });
      expect(m.stats().errors, `cut at ${at}`).toBe(0);
      expect([0, 40], `cut at ${at}`).toContain(m.findings().length);
      if (at < whole.length - 1) expect(m.findings(), `cut at ${at}`).toEqual([]);
      cuts += 1;
      await m.stop();
    }
    expect(cuts).toBeGreaterThan(30);
    writeFileSync(cut, whole);
    expect(createLogMonitor({ store: fileStore(cut) }).findings()).toHaveLength(40);
    for (const junk of ["", "{", "null", "[]", "NaN", "{\"version\":1}", "\u0000\u0000", "﻿" + whole.slice(0, 5)]) {
      writeFileSync(cut, junk);
      expect(createLogMonitor({ store: fileStore(cut) }).findings(), JSON.stringify(junk)).toEqual([]);
    }
  });

  it("reads a file of 1,000 groups, and keeps the 500 with the largest totals", async () => {
    const path = fresh();
    const first = make(path, { limits: { groups: 1000 } });
    const word = (g: number): string => String.fromCharCode(97 + (g % 26), 97 + (Math.floor(g / 26) % 26), 97 + Math.floor(g / 676));
    for (let g = 0; g < 1000; g++) for (let i = 0; i <= g % 40; i++) first.record({ level: "error", message: `failure of kind ${word(g)} happened` });
    await first.stop();
    expect(JSON.parse(readFileSync(path, "utf8")).groups).toHaveLength(1000);
    const second = make(path);
    expect(second.findings()).toHaveLength(500);
    const totals = second.findings().map((f) => f.total);
    expect(Math.min(...totals)).toBeGreaterThanOrEqual(21);
    expect(totals.filter((t) => t === 40)).toHaveLength(25);
  });

  it("survives a hostile file: wrong types, __proto__, 1e308, negatives, NaN as null, a 1 MB string, an array 10,000 deep", async () => {
    const path = await saved();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const put = (text: string): LogMonitor => {
      const p = fresh();
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
      return make(p);
    };
    const withGroup = (patch: Record<string, unknown>): string => JSON.stringify({ ...state, groups: [{ ...state.groups[0], ...patch }, state.groups[1]] });
    const cases: Array<[string, string, number]> = [
      ["total 1e308", withGroup({ total: 1e308 }), 1],
      ["total -1", withGroup({ total: -1 }), 1],
      ["total null (NaN)", withGroup({ total: null }), 1],
      ["counts of strings", withGroup({ counts: ["a"] }), 1],
      ["a 1 MB sample", withGroup({ sample: "w ".repeat(500_000) }), 2],
      ["a 1 MB key", withGroup({ key: "k".repeat(1_000_000) }), 1],
      ["__proto__ as key and id", withGroup({ key: "__proto__", id: "__proto__" }), 1],
      ["__proto__ in families", withGroup({ families: JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"bot":1}') }), 2],
      ["a nested array 10,000 deep", `{"version":1,"savedAt":"${new Date(T0).toISOString()}","batchMinutes":15,"groups":${"[".repeat(10_000)}${"]".repeat(10_000)},"marks":[],"cloud":{}}`, 0],
      ["a nested array in a field", withGroup({ releases: JSON.parse(`${"[".repeat(10_000)}${"]".repeat(10_000)}`) }), 1],
      ["__proto__ at the top", `{"__proto__":{"version":1},"groups":[],"marks":[]}`, 0],
      ["__proto__ marks", JSON.stringify({ ...state, marks: [{ id: "__proto__", known: "x" }, { id: "constructor", fixed: true }] }), 3],
    ];
    for (const [name, text, groups] of cases) {
      const m = put(text);
      expect(m.stats().errors, name).toBe(0);
      expect(m.findings(), name).toHaveLength(groups);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(({} as Record<string, unknown>).y).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it("holds nothing raw in the file: planted secrets in lines, paths and notes", async () => {
    const path = fresh();
    const m = make(path);
    m.record({ level: "error", message: "login for jane.doe@example.com from 10.1.2.3 failed: token=hunter2secret" });
    m.record({ level: "error", message: "upstream said Bearer abcDEF123456ghiJKL789mnopqr at 2001:db8::7 key sk-live_ABCdef1234567890xyz" });
    m.request({ method: "POST", path: "/api/users/jane.doe@example.com/reset?token=SECRETQUERY&e=jane.doe@example.com", status: 500, userAgent: "Mozilla/5.0 SecretBrowser/1.0" });
    m.mark(m.findings()[0].id, { known: "mail jane.doe@example.com about 10.1.2.3" });
    await m.stop();
    const file = readFileSync(path, "utf8");
    for (const secret of ["jane.doe@", "10.1.2.3", "hunter2secret", "abcDEF123456ghiJKL789mnopqr", "2001:db8::7", "sk-live_ABCdef1234567890xyz", "SECRETQUERY", "SecretBrowser"]) expect(file, secret).not.toContain(secret);
    expect(file).toContain("mail [email] about [ip]");
  });
});

describe("real processes", () => {
  let logsJs = "";
  let nodeJs = "";
  beforeAll(async () => {
    logsJs = await bundle("src/logs/index.ts", dir, "logs");
    nodeJs = await bundle("src/logs/node.ts", dir, "logs-node");
  });

  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  });

  /** Starts a script as a child, and resolves with the child and a promise for each line it prints. */
  const start = (name: string, source: string, args: string[]): { child: ChildProcess; lines: string[]; waitFor: (line: string) => Promise<void>; exit: Promise<{ code: number | null; signal: string | null }> } => {
    const file = join(dir, `${name}-${++n}.mjs`);
    writeFileSync(file, source);
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const lines: string[] = [];
    const waiting: Array<{ line: string; done: () => void }> = [];
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const p of parts) {
        lines.push(p);
        for (const w of waiting.splice(0)) (w.line === p ? w.done : () => waiting.push(w))();
      }
    });
    child.stderr!.on("data", (c: Buffer) => process.stderr.write(c));
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const waitFor = (line: string): Promise<void> =>
      lines.includes(line) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        waiting.push({ line, done: resolve });
        void exit.then(() => lines.includes(line) || reject(new Error(`child ended before it printed ${line}`)));
      });
    return { child, lines, waitFor, exit };
  };

  const recorder = (): string => `import { createLogMonitor } from ${JSON.stringify(logsJs)};
import { fileStore } from ${JSON.stringify(nodeJs)};
const logs = createLogMonitor({ store: fileStore(process.argv[2]), onBatch: (b) => console.log("batch " + JSON.stringify(b.findings.map((f) => [f.title, f.judgement, f.total]))) });
logs.record({ level: "error", message: "payment failed for order 8812" });
logs.request({ method: "GET", path: "/users/42", status: 500, userAgent: "curl/8" });
await logs.flush();
console.log("saved");
if (process.argv[3] === "stay") setInterval(() => {}, 1000);
else { await logs.stop(); console.log("stopped"); }
`;

  it("the example in the README runs as written: five lines, a file with mode 0600", () => {
    const section = readFileSync(join(root, "README.md"), "utf8").split("### Findings that survive a restart")[1];
    const code = /```ts\n([\s\S]*?)```/.exec(section)![1];
    expect(code.split("\n").filter((l) => l.trim())).toHaveLength(5);
    const cwd = join(dir, `readme-${++n}`);
    mkdirSync(cwd, { recursive: true });
    const script = join(cwd, "example.mjs");
    writeFileSync(script, code.replace("'@codmir/sdk/logs/node'", JSON.stringify(nodeJs)).replace("'@codmir/sdk/logs'", JSON.stringify(logsJs)));
    const r = spawnSync(process.execPath, [script], { cwd, encoding: "utf8", timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const file = join(cwd, "logs", "state.json");
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).groups.map((g: { key: string }) => g.key)).toEqual(["error|payment failed for order #"]);
  });

  it("a process that records and is killed with SIGKILL after a batch leaves a file a second one starts on", async () => {
    const path = fresh();
    mkdirSync(join(path, ".."), { recursive: true });
    const one = start("rec", recorder(), [path, "stay"]);
    await one.waitFor("saved");
    one.child.kill("SIGKILL");
    expect(await one.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(JSON.parse(readFileSync(path, "utf8")).groups).toHaveLength(2);
    expect(mode(path)).toBe(0o600);
    const two = start("rec", recorder(), [path]);
    await two.waitFor("stopped");
    expect(await two.exit).toEqual({ code: 0, signal: null });
    const batch = JSON.parse(two.lines.find((l) => l.startsWith("batch "))!.slice(6)) as Array<[string, string, number]>;
    expect(batch.map((f) => [f[0], f[1], f[2]]).sort()).toEqual([["GET /users/:n answers 500", "seen", 2], ["payment failed for order #", "seen", 2]]);
  }, 30_000);

  it("a process killed while it saves, again and again, always leaves one whole state", async () => {
    const path = fresh();
    mkdirSync(join(path, ".."), { recursive: true });
    const source = `import { fileStore } from ${JSON.stringify(nodeJs)};
const store = fileStore(process.argv[2]);
const groups = Array.from({ length: 300 }, (_, i) => ({ key: "error|k" + i, id: "00000000", releases: [], sample: "x".repeat(200), total: i + 1, counts: [1], firstMs: 1, lastMs: 1, backCount: 0, fixed: false, families: {}, nonBot: 0, pathHits: 0, scannerHits: 0, durN: 0, durSum: 0, durMax: 0, sentBack: 0, sentAt: 0, sentTotal: 0 }));
let i = 0;
store.save({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups, marks: [], cloud: { day: "", sent: 0 } });
console.log("first");
for (;;) store.save({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups, marks: [{ id: "n" + i++ }], cloud: { day: "", sent: 0 } });
`;
    for (let round = 0; round < 6; round++) {
      const c = start("saver", source, [path]);
      await c.waitFor("first");
      for (let i = 0; i < round * 3; i++) await new Promise((r) => setImmediate(r));
      c.child.kill("SIGKILL");
      await c.exit;
      const state = JSON.parse(readFileSync(path, "utf8")) as LogState;
      expect(state.version).toBe(1);
      expect(state.groups).toHaveLength(300);
      expect(mode(path)).toBe(0o600);
      expect(createLogMonitor({ store: fileStore(path) }).stats().errors).toBe(0);
    }
    // A kill can leave the temporary file of the save it cut: it is named for its process, and the state itself is whole.
    expect(left(path).filter((f) => f !== "state.json").every((f) => /^state\.json\.\d+\.[0-9a-f]{12}\.tmp$/.test(f))).toBe(true);
  }, 60_000);

  it("two processes on one path: the last save wins and the file is always one whole state", async () => {
    const path = fresh();
    mkdirSync(join(path, ".."), { recursive: true });
    const source = `import { fileStore } from ${JSON.stringify(nodeJs)};
const store = fileStore(process.argv[2]);
const who = process.argv[3];
for (let i = 0; i < 300; i++) store.save({ version: 1, savedAt: new Date().toISOString(), batchMinutes: 15, groups: [], marks: [{ id: who, known: "round " + i + " " + "z".repeat(5000) }], cloud: { day: "", sent: 0 } });
console.log("done");
`;
    const a = start("two", source, [path, "a"]);
    const b = start("two", source, [path, "b"]);
    let reads = 0;
    const done = Promise.all([a.waitFor("done"), b.waitFor("done")]);
    let finished = false;
    void done.then(() => (finished = true));
    while (!finished) {
      if (existsSync(path)) {
        const state = JSON.parse(readFileSync(path, "utf8")) as LogState;
        expect(["a", "b"]).toContain(state.marks[0].id);
        reads += 1;
      }
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all([a.exit, b.exit]);
    expect(reads).toBeGreaterThan(5);
    const state = JSON.parse(readFileSync(path, "utf8")) as LogState;
    expect(state.marks[0].known).toMatch(/^round 299 z+$/);
    expect(left(path)).toEqual(["state.json"]);
  }, 60_000);
});
