/**
 * The release (the deployed commit) and the environment come from the host when the app sets neither. An explicit
 * value always wins, and where `process` does not exist nothing throws and the old defaults stay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as O from "../index";

const RELEASE_VARS = [
  "CODMIR_RELEASE",
  "VERCEL_GIT_COMMIT_SHA",
  "RAILWAY_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "SOURCE_VERSION",
  "CF_PAGES_COMMIT_SHA",
  "COMMIT_REF",
  "GITHUB_SHA",
];
const ENVIRONMENT_VARS = ["CODMIR_ENVIRONMENT", "VERCEL_ENV", "NODE_ENV"];

let bodies: any[];
const errors = () => bodies.flatMap((b) => (b.events ?? []).filter((w: any) => w.type === "error"));

/** Every variable the detection reads is empty, so the runner's own (`NODE_ENV=test`, `GITHUB_SHA`) never leaks in. */
function clearHost(): void {
  for (const name of [...RELEASE_VARS, ...ENVIRONMENT_VARS]) vi.stubEnv(name, "");
}

async function send(config: O.OverseerConfig = {}): Promise<{ event: any; body: any }> {
  O.init({ clientKey: "osk_test", includeSourceContext: false, ...config });
  O.captureException(new Error("boom"));
  await O.flush();
  return { event: errors()[0].event, body: bodies[0] };
}

beforeEach(() => {
  bodies = [];
  clearHost();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, req?: RequestInit) => {
      bodies.push(JSON.parse(String(req?.body ?? "{}")));
      return new Response('{"received":true}', { status: 200 });
    }),
  );
});
afterEach(async () => {
  await O.close();
  // Globals first: with `process` stubbed away, the env restore has nothing to restore into.
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("release from the host", () => {
  it("takes VERCEL_GIT_COMMIT_SHA for the event and the envelope", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a1b2c3d");
    const { event, body } = await send();
    expect(event.release).toBe("a1b2c3d");
    expect(body.release).toBe("a1b2c3d");
  });

  it("takes GITHUB_SHA when it is the only one set", async () => {
    vi.stubEnv("GITHUB_SHA", "feed123");
    const { event, body } = await send();
    expect(event.release).toBe("feed123");
    expect(body.release).toBe("feed123");
  });

  it("takes SOURCE_VERSION, and trims", async () => {
    vi.stubEnv("SOURCE_VERSION", "  abc999 \n");
    expect((await send()).event.release).toBe("abc999");
  });

  it("CODMIR_RELEASE wins over the platform variables", async () => {
    vi.stubEnv("CODMIR_RELEASE", "web@2.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a1b2c3d");
    vi.stubEnv("GITHUB_SHA", "feed123");
    const { event, body } = await send();
    expect(event.release).toBe("web@2.0.0");
    expect(body.release).toBe("web@2.0.0");
  });

  it("stays unknown when nothing is set, and an empty or blank variable counts as unset", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "   ");
    expect((await send()).event.release).toBe("unknown");
  });

  it("an empty release option falls back to the host", async () => {
    vi.stubEnv("RENDER_GIT_COMMIT", "r3nd3r");
    expect((await send({ release: "" })).event.release).toBe("r3nd3r");
  });
});

describe("environment from the host", () => {
  it("takes VERCEL_ENV", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    expect((await send()).event.environment).toBe("preview");
  });

  it("takes NODE_ENV when it is the only one set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { event, body } = await send();
    expect(event.environment).toBe("production");
    expect(body.environment).toBe("production");
  });

  it("CODMIR_ENVIRONMENT wins", async () => {
    vi.stubEnv("CODMIR_ENVIRONMENT", "staging");
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await send()).event.environment).toBe("staging");
  });

  it("is development when nothing is set", async () => {
    expect((await send()).event.environment).toBe("development");
  });
});

describe("explicit values", () => {
  it("keep release and environment with every variable set", async () => {
    for (const name of RELEASE_VARS) vi.stubEnv(name, "from-host");
    for (const name of ENVIRONMENT_VARS) vi.stubEnv(name, "from-host");
    const { event, body } = await send({ release: "1.4.2", environment: "staging" });
    expect(event.release).toBe("1.4.2");
    expect(body.release).toBe("1.4.2");
    expect(event.environment).toBe("staging");
    expect(body.environment).toBe("staging");
  });
});

describe("no process", () => {
  it("does not throw and keeps the old defaults", async () => {
    vi.stubGlobal("process", undefined);
    expect(() => O.init({ clientKey: "osk_test", includeSourceContext: false })).not.toThrow();
    O.captureException(new Error("boom"));
    await O.flush();
    const event = errors()[0]?.event;
    expect(event.release).toBe("unknown");
    expect(event.environment).toBe("development");
  });
});

describe("debug", () => {
  it("logs once at init when the release is unknown, naming the option and CODMIR_RELEASE", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    O.init({ clientKey: "osk_test", debug: true });
    const lines = log.mock.calls.map((c) => String(c[1] ?? c[0])).filter((t) => t.includes("CODMIR_RELEASE"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("`release`");
  });

  it("says nothing about the release when one is found", () => {
    vi.stubEnv("GITHUB_SHA", "feed123");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    O.init({ clientKey: "osk_test", debug: true });
    expect(log.mock.calls.some((c) => c.some((a) => String(a).includes("CODMIR_RELEASE")))).toBe(false);
  });
});
