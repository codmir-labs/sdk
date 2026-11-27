// @vitest-environment jsdom
/** In a Next.js browser build the release and environment come from the variables Vercel exposes to client bundles. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureBoundaryError, close, flush, init } from "../index";

let bodies: any[];

beforeEach(() => {
  bodies = [];
  for (const name of ["CODMIR_RELEASE", "VERCEL_GIT_COMMIT_SHA", "GITHUB_SHA", "CODMIR_ENVIRONMENT", "VERCEL_ENV", "NODE_ENV"]) {
    vi.stubEnv(name, "");
  }
  for (const name of ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "K_SERVICE"]) vi.stubEnv(name, "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, req?: RequestInit) => {
      bodies.push(JSON.parse(String(req?.body ?? "{}")));
      return new Response('{"received":true}', { status: 200 });
    }),
  );
});
afterEach(() => {
  close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sent(config: Parameters<typeof init>[0] = {}): Promise<any> {
  init({ dsn: "https://ingest.example.test/api/v1/overseer", clientKey: "osk_test", ...config });
  captureBoundaryError(new Error("boom"));
  await flush();
  return bodies.flatMap((b) => b.events ?? []).find((w: any) => w.type === "error").event;
}

describe("nextjs browser release and environment", () => {
  it("reads NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA and NEXT_PUBLIC_VERCEL_ENV", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA", "c0ffee1");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    const event = await sent();
    expect(event.release).toBe("c0ffee1");
    expect(event.environment).toBe("production");
  });

  it("an explicit value wins", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA", "c0ffee1");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    const event = await sent({ release: "1.4.2", environment: "staging" });
    expect(event.release).toBe("1.4.2");
    expect(event.environment).toBe("staging");
  });
});
