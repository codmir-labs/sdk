/**
 * `captureProcessErrors`: what a Node process does when it crashes, or is told to stop, with errors still queued. Each
 * case runs a fixture in a child process against a local HTTP server standing in for the ingest, because the thing
 * under test is how the process ends. Every child has a hard kill timer.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, until, type FakeServer } from "../../__tests__/helpers/fake-server";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../../..");
let outdir: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "process-errors-"));
  await build({
    entryPoints: { child: join(here, "fixtures/process-errors-child.ts"), readme: join(here, "fixtures/readme-crash.ts") },
    outdir,
    bundle: true,
    platform: "node",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    alias: { "@codmir/sdk": join(root, "src/index.ts") },
    define: { __SDK_VERSION__: '"0.0.0-test"' },
    logLevel: "silent",
  });
}, 60_000);
afterAll(() => rmSync(outdir, { recursive: true, force: true }));

interface Child {
  proc: ReturnType<typeof spawn>;
  stdout: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
}
const children: Child[] = [];

/** Runs a bundled fixture; killed after 10 s whatever it does. */
function run(file: "child" | "readme", env: Record<string, string>): Child {
  const started = Date.now();
  const proc = spawn(process.execPath, [join(outdir, `${file}.cjs`)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const kill = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((resolve) =>
    proc.on("exit", (code, signal) => {
      clearTimeout(kill);
      resolve({ code, signal, ms: Date.now() - started });
    }),
  );
  const child = { proc, stdout: () => out, exited };
  children.push(child);
  return child;
}

afterEach(() => {
  for (const c of children.splice(0)) c.proc.kill("SIGKILL");
});

let ingest: FakeServer;
let hanging: { url: string; close: () => Promise<void> };

/** An ingest that takes the request and never answers. */
async function startHanging(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(() => {});
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}

beforeAll(async () => {
  ingest = await startServer();
  hanging = await startHanging();
});
afterAll(async () => {
  await ingest.close();
  await hanging.close();
});

const eventsFor = (message: string) => ingest.errors("/p1").filter((e) => e.message === message);
const mechanism = (e: { exception?: { mechanism?: unknown } }) => e.exception?.mechanism;

describe("uncaught exception", () => {
  it("(a) with the option on: the event arrives as fatal and unhandled, and the process exits 1", async () => {
    const child = run("child", { SCENARIO: "throw", INGEST: ingest.url });
    const { code, signal } = await child.exited;
    expect([code, signal]).toEqual([1, null]);
    expect(child.stdout()).toContain("child boom");
    await until(() => eventsFor("child boom").length === 1, "the crash event");
    const [event] = eventsFor("child boom");
    expect(event.level).toBe("fatal");
    expect(mechanism(event)).toEqual({ type: "onuncaughtexception", handled: false });
  });

  it("(b) with an app listener: the event arrives and the app decides; a listener that does not exit leaves the child running", async () => {
    const child = run("child", { SCENARIO: "throw-listener", INGEST: ingest.url });
    await until(() => child.stdout().includes("APP_UNCAUGHT"), "the app's listener");
    await until(() => eventsFor("child boom").some((e) => e.level === "fatal"), "the crash event");
    expect(child.proc.exitCode).toBeNull();
    expect(child.proc.signalCode).toBeNull();
    child.proc.kill("SIGKILL");
    const { signal } = await child.exited;
    expect(signal).toBe("SIGKILL");
  });
});

describe("unhandled rejection", () => {
  it("(c) with no app listener: the event arrives and the exit code is 1", async () => {
    const child = run("child", { SCENARIO: "reject", INGEST: ingest.url });
    const { code, signal } = await child.exited;
    expect([code, signal]).toEqual([1, null]);
    await until(() => eventsFor("child rejected").length === 1, "the rejection event (one, not two)");
    const [event] = eventsFor("child rejected");
    expect(event.level).toBe("fatal");
    expect(mechanism(event)).toEqual({ type: "onunhandledrejection", handled: false });
  });

  it("(c) with an app listener: the event arrives and the process keeps running", async () => {
    const child = run("child", { SCENARIO: "reject-listener", INGEST: ingest.url });
    await until(() => child.stdout().includes("APP_REJECTION"), "the app's listener");
    await until(() => eventsFor("child rejected").length >= 1, "the rejection event");
    await new Promise((r) => setTimeout(r, 400));
    expect(child.proc.exitCode).toBeNull();
    child.proc.kill("SIGKILL");
    await child.exited;
  });
});

describe("SIGTERM", () => {
  it("(d) with no app listener: the queued event arrives and the child ends by SIGTERM", async () => {
    const child = run("child", { SCENARIO: "sigterm", INGEST: ingest.url });
    await until(() => child.stdout().includes("CAPTURED"), "the capture");
    await new Promise((r) => setTimeout(r, 200));
    child.proc.kill("SIGTERM");
    const { code, signal } = await child.exited;
    expect(signal).toBe("SIGTERM");
    expect(code).toBeNull();
    await until(() => eventsFor("queued before sigterm").length === 1, "the queued event");
  });

  it("(d) with an app SIGTERM listener: the event arrives and the app's listener runs", async () => {
    const child = run("child", { SCENARIO: "sigterm-listener", INGEST: ingest.url });
    await until(() => child.stdout().includes("CAPTURED"), "the capture");
    await new Promise((r) => setTimeout(r, 200));
    child.proc.kill("SIGTERM");
    await until(() => child.stdout().includes("APP_SIGTERM"), "the app's listener");
    await until(() => eventsFor("queued before sigterm").length >= 1, "the queued event");
    expect(child.proc.exitCode).toBeNull(); // the app did not exit: the SDK did not either
    child.proc.kill("SIGKILL");
    await child.exited;
  });
});

describe("an ingest that never answers", () => {
  it("(e) a crash still ends the process within about 2.5 s", async () => {
    const child = run("child", { SCENARIO: "throw", INGEST: hanging.url });
    const { code, ms } = await child.exited;
    expect(code).toBe(1);
    expect(ms).toBeLessThan(2500 + 700); // 50 ms timer + start-up, on top of the 2 s flush
    expect(ms).toBeGreaterThan(1900);
  });

  it("(e) a rejection ends it too, and so does SIGTERM", async () => {
    const reject = await run("child", { SCENARIO: "reject", INGEST: hanging.url }).exited;
    expect(reject.code).toBe(1);
    expect(reject.ms).toBeLessThan(3200);

    const child = run("child", { SCENARIO: "sigterm", INGEST: hanging.url });
    await until(() => child.stdout().includes("CAPTURED"), "the capture");
    const sent = Date.now();
    child.proc.kill("SIGTERM");
    const { signal } = await child.exited;
    expect(signal).toBe("SIGTERM");
    expect(Date.now() - sent).toBeLessThan(2500);
  });

  it("(g) the README's rejection snippet exits 1 within about 2.5 s", async () => {
    const { code, ms } = await run("readme", { INGEST: hanging.url }).exited;
    expect(code).toBe(1);
    expect(ms).toBeLessThan(3200);
  });
});

describe("close and the option's defaults", () => {
  const counts = () => ["uncaughtException", "uncaughtExceptionMonitor", "unhandledRejection", "SIGTERM", "SIGINT"].map((e) => process.listenerCount(e));

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { close } = await import("../index");
    await close(10);
  });

  it("(f) close(1000) resolves to a boolean within the time and removes the listeners", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { init, captureException, close } = await import("../index");
    const before = counts();
    init({ dsn: "http://127.0.0.1:1/p1", clientKey: "osk_x", captureProcessErrors: true });
    expect(counts()).not.toEqual(before);
    captureException(new Error("never sent"));
    const started = Date.now();
    const sent = await close(1000);
    expect(sent).toBe(false);
    expect(Date.now() - started).toBeLessThan(1700);
    expect(counts()).toEqual(before);
  });

  it("close resolves true when the queue was sent", async () => {
    vi.resetModules();
    const { init, captureException, close } = await import("../index");
    init({ dsn: `${ingest.url}/p2`, clientKey: "osk_x" });
    captureException(new Error("sent on close"));
    expect(await close()).toBe(true);
  });

  it("is off in the core init, on in the Express init unless set to false", async () => {
    vi.resetModules();
    const before = counts();
    const core = await import("../index");
    core.init({ dsn: `${ingest.url}/p2`, clientKey: "osk_x" });
    expect(counts()).toEqual(before);
    await core.close();

    vi.resetModules();
    const express = await import("../../express/index");
    express.init({ dsn: `${ingest.url}/p2`, clientKey: "osk_x" });
    expect(counts()).not.toEqual(before);
    await express.close();
    expect(counts()).toEqual(before);

    vi.resetModules();
    const off = await import("../../express/index");
    off.init({ dsn: `${ingest.url}/p2`, clientKey: "osk_x", captureProcessErrors: false });
    expect(counts()).toEqual(before);
    await off.close();
  });

  it.skip("(h) an Express 4 async route rejection reaches errorHandler() (not built, and express@4 is not a dev dependency)", () => {});
});
