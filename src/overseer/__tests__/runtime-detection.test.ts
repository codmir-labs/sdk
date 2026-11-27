/**
 * Which runtime `contexts` names: Bun, Deno, edge-runtime, workerd, React Native, a browser and Node, in that order.
 * Node 21+ has a global `navigator`, and Bun and Deno set `process.versions.node`; neither makes a browser or Node.
 * Also the `dist` option, which rides on every event beside `release`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerEvent } from "../index";
import { buildBody } from "../transport";
import { resetEnvContexts, setAppOs } from "../runtime-context";
import { CodmirReport } from "../../report/client";

const versions = process.versions as unknown as Record<string, string | undefined>;
let hadBun: PropertyDescriptor | undefined;

beforeEach(() => {
  hadBun = Object.getOwnPropertyDescriptor(versions, "bun");
  resetEnvContexts();
});
afterEach(() => {
  if (hadBun) Object.defineProperty(versions, "bun", hadBun);
  else delete versions.bun;
  vi.unstubAllGlobals();
  setAppOs(undefined);
  resetEnvContexts();
});

function capture(config: Record<string, unknown> = {}): OverseerEvent {
  let seen: OverseerEvent | undefined;
  const c = new OverseerClient({ clientKey: "k", enabled: true, beforeSend: (e) => ((seen = e), null), ...config });
  c.init();
  c.captureException(new Error("boom"));
  c.close();
  return seen!;
}
const contexts = () => {
  resetEnvContexts();
  return capture().contexts as Record<string, Record<string, string>>;
};

describe("runtime contexts", () => {
  it("Node 22 with a global navigator and no window is node", () => {
    vi.stubGlobal("navigator", { userAgent: "Node.js/22" });
    const c = contexts();
    expect(c.runtime).toEqual({ name: "node", version: process.versions.node });
    expect(c.browser).toBeUndefined();
    expect(c.os?.name).toBe(process.platform);
  });

  it("Bun is bun with its own version, not node", () => {
    Object.defineProperty(versions, "bun", { value: "1.2.3", configurable: true, enumerable: true });
    expect(contexts().runtime).toEqual({ name: "bun", version: "1.2.3" });
  });

  it("Deno is deno", () => {
    vi.stubGlobal("Deno", { version: { deno: "2.1.0" } });
    expect(contexts().runtime).toEqual({ name: "deno", version: "2.1.0" });
  });

  it("a string EdgeRuntime is edge-runtime", () => {
    vi.stubGlobal("EdgeRuntime", "edge-runtime");
    const c = contexts();
    expect(c.runtime).toEqual({ name: "edge-runtime" });
    expect(c.os).toBeUndefined();
  });

  it("the Cloudflare user agent is workerd", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    expect(contexts().runtime).toEqual({ name: "workerd" });
  });

  it("React Native with Hermes is hermes on a mobile device; the OS is what the app passed", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("navigator", { product: "ReactNative" });
    vi.stubGlobal("HermesInternal", { getRuntimeProperties: () => ({ "OSS Release Version": "0.12.0" }) });
    let c = contexts();
    expect(c.runtime).toEqual({ name: "hermes", version: "0.12.0" });
    expect(c.device).toEqual({ type: "mobile" });
    expect(c.os).toBeUndefined();

    setAppOs({ platform: "ios", osVersion: "17.5" });
    c = contexts();
    expect(c.os).toEqual({ name: "iOS", version: "17.5" });
    setAppOs({ platform: "android", osVersion: "14" });
    expect(contexts().os).toEqual({ name: "Android", version: "14" });
  });

  it("React Native without Hermes is react-native", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("navigator", { product: "ReactNative" });
    expect(contexts().runtime).toEqual({ name: "react-native" });
  });

  it("an OS the app passes is ignored outside React Native", () => {
    setAppOs({ platform: "ios", osVersion: "17.5" });
    expect(contexts().os?.name).toBe(process.platform);
  });
});

describe("bug report environment", () => {
  async function environment(): Promise<string> {
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response('{"data":{}}', { status: 200 });
      }),
    );
    await new CodmirReport({ projectKey: "k", autoSearch: false }).captureException(new Error("x"), { vendor: "v" });
    return body.environment;
  }

  it("a Node 22 server names Node and no browser", async () => {
    vi.stubGlobal("navigator", { userAgent: "Node.js/22" });
    const env = await environment();
    expect(env).toContain(`node: ${process.version}`);
    expect(env).not.toContain("browser");
  });

  it("a window with a document names the browser", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Test" });
    expect(await environment()).toContain("browser: Mozilla/5.0 Test");
  });
});

describe("dist", () => {
  it("is on an error event beside release, and on the wire", () => {
    const event = capture({ release: "1.2.3", dist: "build-42" });
    expect(event).toMatchObject({ release: "1.2.3", dist: "build-42" });
    const wire = JSON.parse(buildBody([event], { release: "1.2.3" }));
    expect(wire.events[0].event.dist).toBe("build-42");
  });

  it("is cut to 64 characters", () => {
    expect(capture({ dist: "d".repeat(100) }).dist).toBe("d".repeat(64));
  });

  it("is absent when not set or empty", () => {
    expect("dist" in capture()).toBe(false);
    expect("dist" in capture({ dist: "" })).toBe(false);
  });
});

describe("React Native entry", () => {
  it("setDeviceInfo gives events the OS, and close takes it back", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("navigator", { product: "ReactNative" });
    vi.stubGlobal("HermesInternal", {});
    const RN = await import("../../react-native/index");
    RN.setDeviceInfo({ platform: "android", osVersion: "14" });
    expect(contexts()).toMatchObject({ runtime: { name: "hermes" }, os: { name: "Android", version: "14" }, device: { type: "mobile" } });
    RN.close();
    expect(contexts().os).toBeUndefined();
  });
});
