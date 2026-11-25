// @vitest-environment jsdom
/** `PatchRuntime.stop()` before the runtime got going: while the manifest loads, and before the document is ready. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatchRuntime } from "../patch-runtime";

interface Inside {
  manifest: unknown;
  pollTimer: unknown;
  loadManifest(): Promise<void>;
  startObserver(): void;
  applyAll(): void;
}

const make = (load: () => Promise<void> = async () => {}) => {
  const runtime = new PatchRuntime({ dsn: "https://ingest.example.test/api/overseer", environment: "x", overseerKey: "k", config: { enabled: true } });
  const inside = runtime as unknown as Inside;
  vi.spyOn(inside, "loadManifest").mockImplementation(async () => {
    await load();
    inside.manifest = { version: 1, patches: [{ id: "p", type: "css", css: "a{}" }] };
  });
  return { runtime, inside, observe: vi.spyOn(inside, "startObserver").mockImplementation(() => {}), apply: vi.spyOn(inside, "applyAll").mockImplementation(() => {}) };
};

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "readyState");
});

describe("PatchRuntime.stop", () => {
  it("while the manifest loads: nothing starts when it arrives", async () => {
    let arrive = () => {};
    const { runtime, inside, observe, apply } = make(() => new Promise((resolve) => (arrive = resolve)));
    const started = runtime.start();
    runtime.stop();
    arrive();
    await started;
    expect(apply).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(inside.pollTimer).toBeNull();
  });

  it("before the document is ready: DOMContentLoaded applies nothing, and without stop it applies once", async () => {
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    const stopped = make();
    await stopped.runtime.start();
    stopped.runtime.stop();
    const running = make();
    await running.runtime.start();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(stopped.apply).not.toHaveBeenCalled();
    expect(running.apply).toHaveBeenCalledTimes(1);
    running.runtime.stop();
  });
});
