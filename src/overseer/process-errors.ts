/**
 * `captureProcessErrors`: what a Node server needs so a crash or a deploy does not lose its queue. Node ends the process
 * as soon as an uncaught error has been printed or a SIGTERM arrives, which is before the client's one-second send
 * timer, so the hooks here capture, flush for a bounded time, and only then let the process end the way it would have.
 *
 * - `uncaughtExceptionMonitor` (an observer, it never changes what Node does) captures every uncaught error, fatal and
 *   unhandled. The SDK's own `uncaughtException` listener exists only to hold the exit back for the flush: it acts when
 *   it is the only one, and when the app has a listener of its own it does nothing, so the app decides.
 * - `unhandledRejection`: a listener switches Node's default off, so the SDK puts it back: with none of the app's, it
 *   flushes and then does what the `--unhandled-rejections` mode says (by default the rejection is thrown, which ends
 *   the process with code 1 unless the app has an `uncaughtException` listener).
 * - `SIGTERM` and `SIGINT`: flush; when the SDK's listener was the only one, remove it and send the signal again, so the
 *   process ends as it would have. With the app's own listeners it only flushes.
 *
 * Browser-safe to import: a runtime with no `process.on` gets nothing installed.
 */
import { crash, withHint } from "./capture-hint";

/** How long a hook waits for the queue before the process goes on its way. */
export const PROCESS_FLUSH_MS = 2000;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface ProcessErrorsHooks {
  capture: (error: unknown, context: Record<string, unknown>) => unknown;
  flush: (timeoutMs: number) => Promise<boolean>;
}

type Listener = (...args: never[]) => void;
type Proc = NodeJS.Process;

function nodeProcess(): Proc | null {
  const p = (globalThis as { process?: Partial<Proc> }).process;
  return p && typeof p.on === "function" && typeof p.off === "function" && typeof p.listeners === "function" ? (p as Proc) : null;
}

/** The mode of `--unhandled-rejections` this process runs with; Node's default (`throw`) when none is set. */
function rejectionMode(proc: Proc): string {
  const sources = [...(proc.execArgv ?? []), ...(proc.env?.NODE_OPTIONS ?? "").split(/\s+/)];
  let mode = "throw";
  for (const arg of sources) {
    const m = /^--unhandled-rejections=(\w[\w-]*)$/.exec(arg);
    if (m) mode = m[1];
  }
  return mode;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return `Uncaught ${typeof err === "string" ? JSON.stringify(err) : String(err)}`;
  } catch {
    return "Uncaught exception";
  }
}

/** Installs the hooks; the returned function removes every one of them. */
export function installProcessErrors(hooks: ProcessErrorsHooks): () => void {
  const proc = nodeProcess();
  if (!proc) return () => {};

  // The error the SDK threw again for Node to treat as uncaught: its monitor event is a capture already made.
  let rethrown: unknown;
  // That same error, on its way to `onUncaught` with the queue already flushed.
  let flushedFor: unknown;
  let exiting = false;

  const captureFatal = (error: unknown, type: string): void => {
    try {
      hooks.capture(error, withHint({}, crash(type, "fatal", error instanceof Error ? undefined : "none")));
    } catch {
      // never throws into Node's crash path
    }
  };
  const flushed = (): Promise<unknown> => hooks.flush(PROCESS_FLUSH_MS).catch(() => false);
  const others = (event: string, own: Listener): boolean => proc.listeners(event as "exit").some((l) => l !== (own as unknown));

  const onMonitor = (err: unknown, origin?: string): void => {
    if (rethrown !== undefined && err === rethrown) {
      rethrown = undefined;
      return;
    }
    captureFatal(err, origin === "unhandledRejection" ? "onunhandledrejection" : "onuncaughtexception");
  };

  const onUncaught = (err: unknown): void => {
    if (others("uncaughtException", onUncaught)) return; // the app's listener decides
    if (exiting) return;
    exiting = true;
    const done = flushedFor !== undefined && err === flushedFor;
    // Node's own report: the stack, then the version it runs.
    try {
      proc.stderr.write(`\n${describe(err)}\n\nNode.js ${proc.version}\n`);
    } catch {
      // stderr gone: still exit
    }
    void (done ? Promise.resolve() : flushed()).then(() => proc.exit(1));
  };

  const onRejection = (reason: unknown): void => {
    captureFatal(reason, "onunhandledrejection");
    if (others("unhandledRejection", onRejection)) return; // capture only
    const mode = rejectionMode(proc);
    void flushed().then(() => {
      if (mode === "none") return;
      if (mode === "warn" || mode === "warn-with-error-code") {
        try {
          proc.emitWarning(reason instanceof Error ? reason : String(reason), "UnhandledPromiseRejectionWarning");
        } catch {
          // a warning handler that throws is the app's
        }
        if (mode === "warn-with-error-code") proc.exitCode = 1;
        return;
      }
      // throw (the default) and strict: raise it as an uncaught error, which ends the process with code 1 or goes to
      // the app's `uncaughtException` listener, as it would without this hook.
      const error =
        reason instanceof Error
          ? reason
          : Object.assign(new Error(`This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${String(reason)}".`), { code: "ERR_UNHANDLED_REJECTION" });
      rethrown = error;
      flushedFor = error;
      // A timer, not a Node-only API: browser bundles of the core must not name Node globals.
      setTimeout(() => {
        throw error;
      }, 0);
    });
  };

  const signalListeners = new Map<string, Listener>();
  for (const signal of SIGNALS) {
    const onSignal: Listener = () => {
      void flushed().then(() => {
        if (others(signal, onSignal)) return; // the app's listeners decide
        proc.off(signal, onSignal as never);
        signalListeners.delete(signal);
        proc.kill(proc.pid, signal);
      });
    };
    signalListeners.set(signal, onSignal);
    proc.on(signal, onSignal as never);
  }

  proc.on("uncaughtExceptionMonitor", onMonitor as never);
  proc.on("uncaughtException", onUncaught as never);
  proc.on("unhandledRejection", onRejection as never);

  return () => {
    proc.off("uncaughtExceptionMonitor", onMonitor as never);
    proc.off("uncaughtException", onUncaught as never);
    proc.off("unhandledRejection", onRejection as never);
    for (const [signal, listener] of signalListeners) proc.off(signal, listener as never);
    signalListeners.clear();
  };
}
