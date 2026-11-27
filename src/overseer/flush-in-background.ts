/**
 * Sends what is queued before a serverless function is frozen. Browser-safe (no Node import), so `@codmir/sdk/nextjs`
 * and the server wrappers share it. Next.js keeps its per-request context, with `waitUntil`, in a global slot; it is read
 * through `globalThis` and never imported.
 */

import { flush } from "./index";

export type WaitUntil = (promise: Promise<unknown>) => void;

const NEXT_REQUEST_CONTEXT = Symbol.for("@next/request-context");

/** The `waitUntil` of Next's request context, when the code runs inside a request that has one. */
export function nextWaitUntil(): WaitUntil | undefined {
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: unknown } | undefined } | undefined>)[
      NEXT_REQUEST_CONTEXT
    ]?.get?.();
    const waitUntil = ctx?.waitUntil;
    return typeof waitUntil === "function" ? (promise) => void (waitUntil as WaitUntil).call(ctx, promise) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts `flush(timeoutMs)` and hands it to `waitUntil` (the one passed in, else Next's request context) so the platform
 * keeps the function alive until it ends. With neither, the returned promise is the flush: await it. Never throws and
 * never rejects.
 */
export function flushInBackground(timeoutMs = 2000, waitUntil?: WaitUntil): Promise<void> {
  let sending: Promise<void>;
  try {
    sending = Promise.resolve(flush(timeoutMs)).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
  const hand = waitUntil ?? nextWaitUntil();
  if (hand) {
    try {
      hand(sending);
      return Promise.resolve();
    } catch {
      // waitUntil refused it: the caller waits instead
    }
  }
  return sending;
}

/** True on a platform that freezes a function once it answers, or when Next hands this request a `waitUntil`. */
export function isServerlessRuntime(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env && (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY || env.K_SERVICE)) return true;
  return nextWaitUntil() !== undefined;
}
