/**
 * @codmir/sdk/logs/node: what a Node server adds to the log monitor. Node only (it imports node:fs and node:util).
 *
 * ```ts
 * import { createLogMonitor } from "@codmir/sdk/logs";
 * import { captureConsole, captureProcess, fileSink, fileStore, expressLogs } from "@codmir/sdk/logs/node";
 *
 * const logs = createLogMonitor({ onBatch: fileSink("./logs/findings.jsonl"), store: fileStore("./logs/state.json") });
 * captureConsole(logs);
 * captureProcess(logs);
 * app.use(expressLogs(logs));
 * ```
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { objectText } from "./redact";
import type { LogBatch, LogMonitor, LogState, LogStore } from "./types";

type Recorder = Pick<LogMonitor, "record">;
type RequestRecorder = Pick<LogMonitor, "request">;
type ConsoleMethod = "error" | "warn" | "info" | "log" | "debug";

/**
 * Sends what the app prints with `console.error` and `console.warn` (or the methods you name) to the monitor, and
 * still prints it: the original runs after, with the same arguments. Returns a function that puts the originals back.
 * A call the monitor itself makes to the console is passed through, never recorded again.
 */
export function captureConsole(monitor: Recorder, methods: ConsoleMethod[] = ["error", "warn"]): () => void {
  const restores: Array<() => void> = [];
  let inside = false;
  for (const method of new Set(methods)) {
    const original = console[method];
    if (typeof original !== "function") continue;
    let active = true;
    const wrapper = function (this: unknown, ...args: unknown[]): void {
      if (active && !inside) {
        inside = true;
        try {
          // An object on its own is taken by its message: printed, its quoted values would fold every object into one.
          const one = args.length === 1 && !(args[0] instanceof Error) ? objectText(args[0]) : "";
          monitor.record({ level: method === "warn" ? "warning" : method, message: one || format(...args) });
        } catch {
          // the app's own logging never fails because of the monitor
        } finally {
          inside = false;
        }
      }
      return original.apply(this, args as []);
    };
    console[method] = wrapper as typeof console.error;
    restores.push(() => {
      active = false;
      if (console[method] === wrapper) console[method] = original;
    });
  }
  return () => restores.splice(0).forEach((r) => r());
}

/**
 * Records a crash as a fatal line, through `uncaughtExceptionMonitor`, which Node documents as an observer: the process
 * still prints the stack and exits with code 1 (or goes on to your own `uncaughtException` handler). An unhandled
 * rejection reaches the same listener in Node's default mode; in the `warn` modes it arrives as a process warning.
 * No `unhandledRejection` listener is added, because that would change what Node does with one. The open batch is
 * ended on a crash, so `onBatch` (a file sink writes synchronously) sees it before the process is gone.
 */
export function captureProcess(monitor: Recorder & Pick<LogMonitor, "flush">): () => void {
  const note = (message: string, level: "fatal" | "error"): void => {
    try {
      monitor.record({ level, message });
    } catch {
      // never throws into Node's crash path
    }
  };
  const onCrash = (err: unknown, origin?: string): void => {
    note(`${origin === "unhandledRejection" ? "unhandled rejection: " : ""}${errorText(err)}`, "fatal");
    try {
      void monitor.flush().catch(() => undefined);
    } catch {
      // see above
    }
  };
  const onWarning = (w: Error): void => {
    if (w?.name === "UnhandledPromiseRejectionWarning") note(`unhandled rejection: ${w.message}`, "error");
  };
  process.on("uncaughtExceptionMonitor", onCrash);
  process.on("warning", onWarning);
  return () => {
    process.off("uncaughtExceptionMonitor", onCrash);
    process.off("warning", onWarning);
  };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.stack ?? `${err.name}: ${err.message}` : String(err));

export const SINK_MAX_BYTES = 5 * 1024 * 1024;
export const SINK_KEEP = 2;

/**
 * An `onBatch` that appends each batch as one JSON line to `path` (file mode 0600; its folder is made when missing). At
 * 5 MB the file is renamed to `path.1` (and `path.1` to `path.2`; older ones are deleted), so the sink holds at most
 * about 15 MB. It never throws.
 */
export function fileSink(path: string): (batch: LogBatch) => void {
  return (batch) => {
    try {
      const line = `${JSON.stringify(batch)}\n`;
      if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
      else if (statSync(path).size + line.length > SINK_MAX_BYTES) rotate(path);
      appendFileSync(path, line, { mode: 0o600 });
      // A file made earlier with wider rights is narrowed too.
      if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
    } catch {
      // a full disk or a missing folder must not reach the app
    }
  };
}

function rotate(path: string): void {
  const oldest = `${path}.${SINK_KEEP}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = SINK_KEEP - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  renameSync(path, `${path}.1`);
}

export const STORE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A `store` for `createLogMonitor` that keeps the state in one JSON file, so findings and marks survive a restart. A save
 * writes a temporary file next to `path` (mode 0600, created exclusively, named for this process) and renames it over
 * `path`: the file is always one whole state, a failed write leaves the old one and no temporary file, and a file
 * with wider rights is replaced by one with 0600. The folder is made when missing. A load reads a regular file of at most
 * 5 MB (a symbolic link, a folder or a device gives an empty start, and so does a file that is not a state). Two processes
 * on one path: the last save wins; give each process its own file.
 */
export function fileStore(path: string): LogStore {
  return {
    load(): unknown {
      let fd = -1;
      try {
        if (!lstatSync(path).isFile()) return undefined;
        // O_NOFOLLOW and O_NONBLOCK: a link or a pipe swapped in after the check is not followed or waited on.
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > STORE_MAX_BYTES) return undefined;
        const buf = Buffer.alloc(info.size);
        let read = 0;
        while (read < buf.length) {
          const n = readSync(fd, buf, read, buf.length - read, read);
          if (n <= 0) break;
          read += n;
        }
        return JSON.parse(buf.toString("utf8", 0, read));
      } catch {
        return undefined; // missing, unreadable or broken: an empty start
      } finally {
        if (fd >= 0) closeSync(fd);
      }
    },

    save(state: LogState): void {
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        renameSync(tmp, path);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          // it was never made
        }
        throw err;
      }
    },
  };
}

const pathOnly = (url: string): string => {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
};

interface ExpressReq {
  method: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  headers?: Record<string, string | string[] | undefined>;
}
interface ExpressRes {
  statusCode: number;
  once(event: string, listener: () => void): unknown;
}

/** Express middleware: one `monitor.request` per answered request, with its route (or its path without the query), status and duration. */
export function expressLogs(monitor: RequestRecorder): (req: ExpressReq, res: ExpressRes, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    const started = performance.now();
    res.once("finish", () => {
      try {
        const route = typeof req.route?.path === "string" ? `${req.baseUrl ?? ""}${req.route.path}` : "";
        const ua = req.headers?.["user-agent"];
        monitor.request({
          method: req.method,
          path: route || pathOnly(req.originalUrl ?? req.url ?? "/"),
          status: res.statusCode,
          durationMs: performance.now() - started,
          userAgent: Array.isArray(ua) ? ua[0] : ua,
        });
      } catch {
        // the response is already sent
      }
    });
    next();
  };
}

/** What {@link honoLogs} reads of Hono's context; `hono` itself is not imported, so an app without it still type-checks. */
interface HonoContext {
  req: { method: string; path: string; matchedRoutes: ReadonlyArray<{ path: string }>; header(name: string): string | undefined };
  res: { status: number };
}

/** Hono middleware: the same as {@link expressLogs}, with the matched route when there is one. */
export function honoLogs(monitor: RequestRecorder): (c: HonoContext, next: () => Promise<void>) => Promise<void> {
  return async (c, next) => {
    const started = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      try {
        const matched = c.req.matchedRoutes;
        const handler = matched.length > 0 ? matched[matched.length - 1].path : "";
        monitor.request({
          method: c.req.method,
          // A path that ends in `*` is a middleware's (nothing else matched): the request's own path says more.
          path: handler && !handler.endsWith("*") ? handler : pathOnly(c.req.path),
          status,
          durationMs: performance.now() - started,
          userAgent: c.req.header("user-agent"),
        });
      } catch {
        // see above
      }
    }
  };
}
