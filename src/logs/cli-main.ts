/**
 * The `codmir-logs` command: finds problems in logs an app already has, on this machine, with no account and no network
 * (the network is only used with `--cloud`). Everything it prints went through {@link clean}: a log line can hold terminal
 * commands, and none of them reaches the screen.
 */
import { closeSync, openSync, statSync } from "node:fs";
import { createLogMonitor } from "./monitor";
import { fileStore, followFile, readLog } from "./node";
import type { Follower, ReadResult } from "./read";
import type { Finding, Judgement, LogBatch, LogFormat, LogLevel, LogMonitor, LogMonitorOptions } from "./types";

declare const __SDK_VERSION__: string | undefined;
const VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0";

const FORMATS: LogFormat[] = ["auto", "json", "vercel", "railway", "journald", "pino", "clf", "text"];
const LEVELS: LogLevel[] = ["debug", "info", "warning", "error", "fatal"];
const ORDER: Judgement[] = ["alarm", "new", "back", "seen", "known", "noise"];

const SEQ = /(?:\x1b[\]P^_X]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]{0,4096}(?:\x07|\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]?|\x1b[ -~]?/g; // eslint-disable-line no-control-regex
const CTRL = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]", "g");

/** A text as it may be printed: escape sequences, control characters and the characters that reorder or hide text are gone. */
export const clean = (s: unknown): string =>
  String(s)
    .replace(SEQ, "")
    .replace(CTRL, (c) => (c === "\n" || c === "\t" || c === "\r" ? " " : ""));

const deepClean = (v: unknown): unknown =>
  typeof v === "string" ? clean(v) : Array.isArray(v) ? v.map(deepClean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), deepClean(x)])) : v;

const HELP = `codmir-logs: find problems in logs you already have. Local: no account, no network (except with --cloud).

Usage
  codmir-logs [files...] [options]        no file (or -) reads standard input; .gz files are unpacked
  codmir-logs mark <id> --known <note> --state <file>
  codmir-logs mark <id> --fixed --state <file>

Options
  --format <f>       auto (default), json, vercel, railway, journald, pino, clf, text
  --json             print one JSON document (with --follow, one per batch, one line each)
  --state <file>     keep findings and marks here, so the next run knows what is new
  --min-status <n>   lowest status that is a finding (default 400)
  --level <l>        lowest level that is a finding: debug, info, warning (default), error, fatal
  --noise <text>     lines or requests with this text are noise (repeatable)
  --service <name>   service for lines that do not name one
  --release <name>   release for lines that do not name one
  --follow           keep reading files as they grow (or standard input) and print each finished batch
  --batch <min>      minutes per batch with --follow (default 1)
  --fail-on <what>   exit 1 when: new (a new, back or alarm finding), alarm (an alarm), any (anything but noise and known)
  --top <n>          rows printed (default 20)
  --cloud            also send the findings to Codmir (needs CODMIR_CLIENT_KEY; nothing is sent without this flag)
  --help, --version

Exit codes: 0 done, 1 --fail-on matched, 2 wrong call or unreadable file.
Colour only on a terminal and when NO_COLOR is unset.
`;

interface Args {
  files: string[];
  format: LogFormat;
  json: boolean;
  state?: string;
  minStatus?: number;
  level: LogLevel;
  noise: string[];
  service?: string;
  release?: string;
  follow: boolean;
  batch?: number;
  failOn?: "new" | "alarm" | "any";
  top: number;
  cloud: boolean;
  help: boolean;
  version: boolean;
  mark?: { id: string; known?: string; fixed: boolean };
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--format", "--state", "--min-status", "--level", "--noise", "--service", "--release", "--fail-on", "--top", "--batch", "--known"]);
const BOOL_FLAGS = new Set(["--json", "--follow", "--cloud", "--help", "-h", "--version", "-v", "--fixed"]);

function parseArgs(argv: string[]): Args {
  const a: Args = { files: [], format: "auto", json: false, level: "warning", noise: [], follow: false, top: 20, cloud: false, help: false, version: false };
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (rest || arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOL_FLAGS.has(flag) && eq < 0) flags.set(flag, [""]);
    else if (VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`${clean(flag)} needs a value`);
      flags.set(flag, [...(flags.get(flag) ?? []), value]);
    } else throw new UsageError(`unknown option ${clean(arg)}`);
  }
  const last = (f: string): string | undefined => flags.get(f)?.at(-1);
  const int = (f: string, min: number, max: number): number | undefined => {
    const v = last(f);
    if (v === undefined) return undefined;
    const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) throw new UsageError(`${f} takes a whole number from ${min} to ${max}`);
    return n;
  };
  a.help = flags.has("--help") || flags.has("-h");
  a.version = flags.has("--version") || flags.has("-v");
  a.json = flags.has("--json");
  a.follow = flags.has("--follow");
  a.cloud = flags.has("--cloud");
  const format = last("--format");
  if (format !== undefined) {
    if (!FORMATS.includes(format as LogFormat)) throw new UsageError(`--format is one of ${FORMATS.join(", ")}`);
    a.format = format as LogFormat;
  }
  const level = last("--level")?.toLowerCase();
  if (level !== undefined) {
    const l = level === "warn" ? "warning" : level;
    if (!LEVELS.includes(l as LogLevel)) throw new UsageError(`--level is one of ${LEVELS.join(", ")}`);
    a.level = l as LogLevel;
  }
  const failOn = last("--fail-on");
  if (failOn !== undefined) {
    if (failOn !== "new" && failOn !== "alarm" && failOn !== "any") throw new UsageError("--fail-on is one of new, alarm, any");
    a.failOn = failOn;
  }
  a.state = last("--state");
  a.service = last("--service");
  a.release = last("--release");
  a.noise = flags.get("--noise") ?? [];
  a.minStatus = int("--min-status", 0, 1000);
  a.top = int("--top", 1, 100_000) ?? 20;
  a.batch = int("--batch", 1, 10_080);
  if (positional[0] === "mark" && !rest) {
    const known = last("--known");
    const fixed = flags.has("--fixed");
    if (positional.length !== 2) throw new UsageError("mark takes one finding id");
    if (!a.state) throw new UsageError("mark needs --state <file>");
    if ((known === undefined) === !fixed) throw new UsageError("mark needs --known <note> or --fixed, one of them");
    a.mark = { id: positional[1], known, fixed };
  } else {
    if (flags.has("--known") || flags.has("--fixed")) throw new UsageError("--known and --fixed belong to: codmir-logs mark <id>");
    a.files = positional;
  }
  return a;
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const when = (iso: string): string => clean(iso).replace("T", " ").slice(0, 19);
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const COLOR: Record<string, string> = { alarm: "31", new: "33", back: "35", known: "2", noise: "2" };

interface Counts extends ReadResult {
  files: number;
}
const sum = (a: Counts, b: ReadResult): Counts => ({ files: a.files, lines: a.lines + b.lines, records: a.records + b.records, requests: a.requests + b.requests, skipped: a.skipped + b.skipped, bytes: a.bytes + b.bytes });
const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function table(findings: Finding[], top: number, color: boolean): string[] {
  const sorted = [...findings].sort((a, b) => ORDER.indexOf(a.judgement) - ORDER.indexOf(b.judgement) || b.hits - a.hits || b.total - a.total);
  const shown = sorted.slice(0, top);
  if (shown.length === 0) return [];
  const width = Math.min(72, Math.max(5, ...shown.map((f) => clean(f.title).length)));
  const paint = (j: string, s: string): string => (color && COLOR[j] ? `\x1b[${COLOR[j]}m${s}\x1b[0m` : s);
  const rows = [`${pad("", 0)}${pad("JUDGED", 7)} ${"HITS".padStart(6)}  ${pad("TITLE", width)}  ${pad("FIRST SEEN", 19)}  LAST SEEN`];
  for (const f of shown) {
    rows.push(`${paint(f.judgement, pad(clean(f.judgement), 7))} ${String(f.hits).padStart(6)}  ${pad(cut(clean(f.title), width), width)}  ${when(f.firstSeen)}  ${when(f.lastSeen)}`);
  }
  if (sorted.length > shown.length) rows.push(`… ${sorted.length - shown.length} more (--top ${sorted.length} shows all)`);
  return rows;
}

function summary(findings: Finding[], read: Counts): string {
  const by = ORDER.map((j) => [j, findings.filter((f) => f.judgement === j).length] as const).filter(([, n]) => n > 0);
  const found = findings.length === 0 ? "no findings" : `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${by.map(([j, n]) => `${n} ${j}`).join(", ")}`;
  return `read ${read.lines} lines (${kb(read.bytes)}): ${read.records} records, ${read.requests} requests, ${read.skipped} skipped. ${found}.`;
}

const matches = (rule: "new" | "alarm" | "any", findings: Finding[]): boolean =>
  findings.some((f) => (rule === "alarm" ? f.judgement === "alarm" : rule === "new" ? f.judgement === "new" || f.judgement === "back" || f.judgement === "alarm" : f.judgement !== "noise" && f.judgement !== "known"));

const levelsFrom = (l: LogLevel): LogLevel[] => LEVELS.slice(LEVELS.indexOf(l));

export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
}

/** Runs the command; resolves with its exit code. */
export async function main(argv: string[], io: Io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr.write(`codmir-logs: ${err.message}. Try --help.\n`);
    return 2;
  }
  if (args.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const fail = (msg: string): number => {
    io.stderr.write(`codmir-logs: ${clean(msg)}\n`);
    return 2;
  };
  const color = Boolean(io.stdout.isTTY) && io.env.NO_COLOR === undefined;

  const store = args.state ? fileStore(args.state) : undefined;
  const key = io.env.CODMIR_CLIENT_KEY;
  if (args.cloud && !key) return fail("--cloud needs the project key in CODMIR_CLIENT_KEY");
  let batchSeen: LogBatch | undefined;
  const all: Finding[][] = [];
  let totals: Counts = { files: 0, lines: 0, records: 0, requests: 0, skipped: 0, bytes: 0 };
  const print = (batch: LogBatch): void => {
    all.push(batch.findings);
    if (!args.follow) return;
    if (args.json) io.stdout.write(`${JSON.stringify(deepClean({ batch: { from: batch.from, to: batch.to, records: batch.records }, findings: batch.findings, read: totals }))}\n`);
    else io.stdout.write(`${[`batch ${when(batch.to)}`, ...table(batch.findings, args.top, color), summary(batch.findings, totals)].join("\n")}\n`);
  };
  const options: LogMonitorOptions = {
    service: args.service,
    release: args.release,
    // One run is one batch: the timer must not end it early. With --follow a batch is what is printed.
    batchMinutes: args.follow ? (args.batch ?? 1) : 10_080,
    include: { levels: levelsFrom(args.level), ...(args.minStatus !== undefined ? { minStatus: args.minStatus } : {}) },
    noise: args.noise,
    store,
    cloud: args.cloud ? { apiKey: key, dsn: io.env.CODMIR_DSN || undefined } : false,
    onBatch: (b) => {
      batchSeen = b;
      print(b);
    },
  };
  const monitor: LogMonitor = createLogMonitor(options);

  if (args.mark) {
    const found = monitor.mark(args.mark.id, args.mark.known !== undefined ? { known: args.mark.known } : { fixed: true });
    await monitor.stop();
    const id = clean(args.mark.id);
    io.stdout.write(args.mark.known !== undefined ? `marked ${id} as known\n` : `marked ${id} as fixed: its next hit is judged back\n`);
    if (!found) io.stderr.write("codmir-logs: no finding with that id in the state yet; the mark is kept for when it appears\n");
    return 0;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const finish = async (): Promise<void> => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };

  try {
    const files = args.files.filter((f) => f !== "-");
    for (const f of files) {
      let st;
      try {
        st = statSync(f);
        if (st.isDirectory()) return fail(`cannot read ${f}: it is a folder`);
        if (st.isFile()) closeSync(openSync(f, "r"));
      } catch (err) {
        return fail(`cannot read ${f}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
      }
    }
    const useStdin = args.files.length === 0 || args.files.includes("-");
    if (args.files.length === 0 && io.stdin.isTTY) return fail("no file given and standard input is a terminal. Try --help");
    if (args.follow && files.length > 0 && useStdin) return fail("--follow reads files or standard input, not both");

    const followers: Follower[] = [];
    try {
      if (args.follow && files.length > 0) {
        for (const f of files) followers.push(followFile(f, monitor, { format: args.format, from: "start", onError: () => undefined }));
        await Promise.all(followers.map((f) => f.ready));
        const current = (): Counts => followers.reduce((t, f) => sum(t, f.counts()), { ...totals, lines: 0, records: 0, requests: 0, skipped: 0, bytes: 0, files: files.length });
        totals = current();
        const tick = setInterval(() => void (totals = current()), 250);
        tick.unref();
        await monitor.flush();
        // The followers' timers do not keep the process alive; this does, until Ctrl-C.
        const hold = setInterval(() => undefined, 1 << 30);
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) return resolve();
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        clearInterval(hold);
        clearInterval(tick);
        await Promise.all(followers.map((f) => f.stop()));
        totals = current();
      } else {
        const sources: Array<string | NodeJS.ReadableStream> = [...files, ...(useStdin ? [io.stdin] : [])];
        totals.files = sources.length;
        for (const s of sources) {
          const r = await readLog(s as string | AsyncIterable<Uint8Array>, monitor, { format: args.format, signal: controller.signal });
          totals = sum(totals, r);
          if (r.aborted) break;
        }
      }
    } catch (err) {
      await monitor.stop();
      const where = followers.length ? "" : "";
      return fail(`cannot read the input${where}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }

    await monitor.flush();
    const findings = batchSeen?.findings ?? [];
    if (args.cloud) await monitor.stop();
    else await monitor.stop();
    const stats = monitor.stats();
    if (store && stats.errors > 0) io.stderr.write("codmir-logs: the state file could not be written\n");
    if (!args.follow) {
      if (args.json) {
        io.stdout.write(`${JSON.stringify(deepClean({ findings, read: totals, ...(batchSeen ? { batch: { from: batchSeen.from, to: batchSeen.to, records: batchSeen.records } } : {}) }), null, 2)}\n`);
      } else {
        io.stdout.write(`${[...table(findings, args.top, color), summary(findings, totals)].join("\n")}\n`);
      }
    }
    if (args.cloud && !args.json) io.stdout.write(`sent ${stats.cloud.sent} finding${stats.cloud.sent === 1 ? "" : "s"} to Codmir\n`);
    if (interrupted) return args.follow ? 0 : 130;
    const rule = args.failOn;
    const seen = args.follow ? all.flat() : findings;
    return rule && matches(rule, seen) ? 1 : 0;
  } finally {
    await finish();
  }
}
