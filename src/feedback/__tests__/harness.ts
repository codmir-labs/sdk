import { vi } from "vitest";
import type { OverseerConfig } from "../../overseer/index";
import { createDoor, doorFetch, type Door } from "./door";

export const DSN = "https://app.example/api/overseer";
export const PAGE = "https://app.example";
export const REPLAY_ID = "5d0a6d1c-7a33-4c2f-9b53-0f6a1d8b6d11";

export interface Harness {
  fb: typeof import("../index");
  overseer: typeof import("../../overseer/index");
  tracing: typeof import("../../tracing/index");
  door: Door;
  calls: Array<{ url: string; init: RequestInit }>;
  /** What the client holds: breadcrumbs, last error. */
  context: () => ReturnType<NonNullable<ReturnType<typeof import("../../overseer/index").getClient>>["feedbackContext"]>;
}

/** Fresh modules (the feedback module keeps state), a door behind `fetch`, and a client made by `init()`. */
export async function setup(config: OverseerConfig | null = {}, opts: { page?: string; door?: Door } = {}): Promise<Harness> {
  vi.resetModules();
  const door = opts.door ?? createDoor();
  const { fetch: stub, calls } = doorFetch(door);
  vi.stubGlobal("fetch", stub);
  if (opts.page) vi.stubGlobal("location", new URL(opts.page));
  const overseer = await import("../../overseer/index");
  const tracing = await import("../../tracing/index");
  const fb = await import("../index");
  if (config) overseer.init({ dsn: DSN, clientKey: "osk_test", ...config });
  return { fb, overseer, tracing, door, calls, context: () => overseer.getClient()!.feedbackContext() };
}

export function teardown(h?: Harness): void {
  h?.overseer.close();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("codmir.overseer.client")];
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

/** A `localStorage` over a Map: `failing` makes a method throw. */
export function fakeLocalStorage(initial: Record<string, string> = {}, failing: { get?: boolean; set?: boolean } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k: string) {
      if (failing.get) throw new DOMException("denied", "SecurityError");
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (failing.set) throw new DOMException("full", "QuotaExceededError");
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
  };
}
