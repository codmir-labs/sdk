/**
 * Reads logs that already exist into a monitor: a file, a stream or any async iterable of text (`readLog`), or a file that
 * is still being written (`followFile`). Node only. Memory stays flat: a chunk is split into lines, each line goes to the
 * monitor and is dropped, a line is cut to 64 KB, and the next chunk is not asked for before this one is done.
 */
import { closeSync, constants as fsConstants, createReadStream, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { constants as zlibConstants, createGunzip } from "node:zlib";
import { MAX_LINE, Seen, parseLogLines } from "./parse";
import type { LogFormat, LogMonitor } from "./types";

type Sink = Pick<LogMonitor, "record" | "request">;
type Chunk = string | Uint8Array;

export interface ReadOptions {
  /** How lines are read; default `auto`. */
  format?: LogFormat;
  /** Stops reading at once and resolves with what was read so far (`aborted: true`). */
  signal?: AbortSignal;
}

export interface ReadResult {
  /** Lines read, empty ones included. */
  lines: number;
  /** Log records and requests handed to the monitor. A JSON array of objects is one line and several of these. */
  records: number;
  requests: number;
  /** Lines that said nothing (empty, a prompt, a stack-trace line, a summary). */
  skipped: number;
  /** Bytes read from the source, before a gzip file is unpacked. */
  bytes: number;
  aborted?: boolean;
}

const zero = (): ReadResult => ({ lines: 0, records: 0, requests: 0, skipped: 0, bytes: 0 });

/** Splits chunks into lines across chunk and UTF-8 borders; `\r\n` ends a line like `\n`; a line over 64 KB keeps its first 64 KB. */
class Lines {
  private dec = new StringDecoder("utf8");
  private carry = "";
  private over = false;
  private open = false;
  private first = true;

  constructor(private readonly on: (line: string) => void) {}

  push(chunk: Chunk): void {
    const s = typeof chunk === "string" ? chunk : this.dec.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let pos = 0;
    for (;;) {
      const nl = s.indexOf("\n", pos);
      if (nl < 0) {
        this.add(s.slice(pos));
        return;
      }
      this.add(s.slice(pos, nl));
      this.emit();
      pos = nl + 1;
    }
  }

  /** The end of the input: a last line without a newline still counts. */
  end(): void {
    this.add(this.dec.end());
    if (this.open) this.emit();
  }

  /** The input started over (a truncated file): what is held is dropped. */
  reset(): void {
    this.dec = new StringDecoder("utf8");
    this.carry = "";
    this.over = false;
    this.open = false;
  }

  private add(piece: string): void {
    if (!piece) return;
    this.open = true;
    if (this.over) return;
    this.carry += piece;
    if (this.carry.length > MAX_LINE) {
      this.carry = this.carry.slice(0, MAX_LINE);
      this.over = true;
    }
  }

  private emit(): void {
    let line = this.carry;
    this.carry = "";
    this.over = false;
    this.open = false;
    if (this.first) {
      this.first = false;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }
    this.on(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

const seenBy = new WeakMap<object, Seen>();

/** What happens to every line: parsed, and handed to the monitor as a record or a request. */
function sinkOf(monitor: Sink, format: LogFormat, res: ReadResult): (line: string) => void {
  // The request ids of a drain are the monitor's: a request counts once however many reads feed the same monitor.
  let seen = seenBy.get(monitor);
  if (!seen) seenBy.set(monitor, (seen = new Seen()));
  return (line) => {
    res.lines += 1;
    const parsed = parseLogLines(line, format, seen);
    if (parsed.length === 0) res.skipped += 1;
    for (const p of parsed) {
      if ("record" in p) {
        monitor.record(p.record);
        res.records += 1;
      } else {
        monitor.request(p.request);
        res.requests += 1;
      }
    }
  };
}

const byteLength = (c: Chunk): number => (typeof c === "string" ? Buffer.byteLength(c) : c.byteLength);
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The chunks of a source; a gzip stream (by its first two bytes, not by the name) comes out unpacked. `onBytes` sees the raw size. */
async function* chunksOf(source: string | AsyncIterable<Chunk>, onBytes: (n: number) => void, signal?: AbortSignal): AsyncGenerator<Chunk> {
  const it = (typeof source === "string" ? createReadStream(source, { highWaterMark: 64 * 1024 }) : source)[Symbol.asyncIterator]();
  // Not `Promise.race([it.next(), aborted])`: that hangs a reaction on `aborted` per chunk, and every chunk stays in memory.
  let wake: (() => void) | undefined;
  const onAbort = (): void => wake?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  const next = async (): Promise<IteratorResult<Chunk> | null> => {
    const r = await new Promise<IteratorResult<Chunk> | null>((resolve, reject) => {
      if (signal?.aborted) return resolve(null);
      wake = () => resolve(null);
      it.next().then(resolve, reject);
    });
    wake = undefined;
    if (r && !r.done) onBytes(byteLength(r.value));
    return r;
  };
  let gz: ReturnType<typeof createGunzip> | undefined;
  try {
    const head: Chunk[] = [];
    let n = 0;
    let finished = false;
    while (n < 2) {
      const r = await next();
      if (!r || r.done) {
        finished = true;
        if (!r) return;
        break;
      }
      head.push(r.value);
      n += byteLength(r.value);
    }
    const bytes = Buffer.concat(head.filter((h): h is Uint8Array => typeof h !== "string").map((h) => h.subarray(0, 2)));
    const isGzip = head.length > 0 && head.every((h) => typeof h !== "string") && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!isGzip) {
      yield* head;
      while (!finished) {
        const r = await next();
        if (!r || r.done) return;
        yield r.value;
      }
      return;
    }
    // A log that is still being written ends in the middle of a gzip member: what was unpacked is kept, no error.
    gz = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
    const rest = (async function* (): AsyncGenerator<Chunk> {
      yield* head;
      while (!finished) {
        const r = await next();
        if (!r || r.done) return;
        yield r.value;
      }
    })();
    pipeline(Readable.from(rest, { objectMode: false }), gz, () => undefined);
    for await (const out of gz) yield out as Buffer;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    gz?.destroy();
    void Promise.resolve(it.return?.()).catch(() => undefined);
  }
}

/**
 * Reads a log into a monitor. `source` is a path (gzip is recognised by its first bytes), a readable stream or an async
 * iterable of strings or buffers. Resolves with the counts; nothing is flushed: end the batch with `monitor.flush()`.
 * Rejects when the source cannot be read.
 */
export async function readLog(source: string | AsyncIterable<Chunk>, monitor: Sink, options: ReadOptions = {}): Promise<ReadResult> {
  const res = zero();
  const { signal } = options;
  if (signal?.aborted) return { ...res, aborted: true };
  const lines = new Lines(sinkOf(monitor, options.format ?? "auto", res));
  let chunks = 0;
  for await (const chunk of chunksOf(source, (n) => void (res.bytes += n), signal)) {
    if (signal?.aborted) break;
    lines.push(chunk);
    if (++chunks % 64 === 0) await yieldToLoop();
  }
  if (signal?.aborted) return { ...res, aborted: true };
  lines.end();
  return res;
}

export interface FollowOptions {
  format?: LogFormat;
  /** Where to start in a file that exists: `end` (default) reads only what is written from now on. A file that appears later, or after a rotation, is read from its start. */
  from?: "end" | "start";
  /** Milliseconds between looks at the file; default 1000. */
  intervalMs?: number;
  /** Called with what a look could not do (a file that cannot be opened); the next look tries again. */
  onError?: (err: unknown) => void;
}

export interface Follower {
  /** Stops, after the look in progress. A last line without a newline is dropped: the writer has not finished it. */
  stop(): Promise<void>;
  /** What was read since the start. */
  counts(): ReadResult;
  /** Resolves once the first look is done: what was in the file at the start (with `from: "start"`) is read. */
  ready: Promise<void>;
}

const tryStat = (path: string): Stats | undefined => {
  try {
    return statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw err;
  }
};

/**
 * Follows a regular file as it grows: by looking at it every `intervalMs` with `stat` (no native watcher; the timer never
 * keeps the process alive). It goes on after the file is truncated (copy-truncate), replaced (rotation by rename: the old
 * file is read to its end first) or missing (until it comes back). Throws when `path` exists and is not a regular file.
 * A file truncated and written past its old size between two looks is not noticed.
 */
export function followFile(path: string, monitor: Sink, options: FollowOptions = {}): Follower {
  const first = tryStat(path);
  if (first && !first.isFile()) throw new TypeError("followFile: not a regular file");
  const res = zero();
  const lines = new Lines(sinkOf(monitor, options.format ?? "auto", res));
  const buf = Buffer.allocUnsafe(64 * 1024);
  let fd = -1;
  let id = "";
  let pos = 0;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const attach = (from: "end" | "start"): void => {
    const opened = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    // The file that was opened, not the one a `stat` saw before it: a rotation in between would be read twice.
    const st = fstatSync(opened);
    if (!st.isFile()) {
      closeSync(opened);
      throw new TypeError("followFile: not a regular file");
    }
    fd = opened;
    id = `${st.dev}:${st.ino}`;
    pos = from === "end" ? st.size : 0;
    lines.reset();
  };
  const detach = (): void => {
    if (fd >= 0) closeSync(fd);
    fd = -1;
  };
  const drain = async (): Promise<void> => {
    if (fstatSync(fd).size < pos) {
      pos = 0;
      lines.reset();
    }
    for (let k = 1; !stopped; k++) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      res.bytes += n;
      lines.push(buf.subarray(0, n));
      if (k % 16 === 0) await yieldToLoop();
    }
  };
  const look = async (): Promise<void> => {
    try {
      if (fd >= 0) await drain();
      const st = tryStat(path);
      if (st && !st.isFile()) throw new TypeError("followFile: not a regular file");
      if (fd >= 0 && (!st || `${st.dev}:${st.ino}` !== id)) {
        // Rotated away or gone: what was written between the read above and the rotation, then its last line, which is complete now.
        await drain();
        lines.end();
        detach();
      }
      if (fd < 0 && st && !stopped) {
        attach("start");
        await drain();
      }
    } catch (err) {
      options.onError?.(err);
    }
  };
  const tick = (): void => {
    running = running.then(look);
  };

  if (first) attach(options.from === "start" ? "start" : "end");
  tick();
  const ready = running;
  const timer = setInterval(tick, Math.max(10, options.intervalMs ?? 1000));
  timer.unref();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await running;
      lines.reset();
      detach();
    },
    counts: () => ({ ...res }),
    ready,
  };
}
