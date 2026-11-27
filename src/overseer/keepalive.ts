/**
 * One keepalive budget for everything the SDK sends as a page hides.
 *
 * A browser refuses a `keepalive` request when its body, plus the bodies of every keepalive request of the same page
 * still in flight, is over 64 KiB. The error transport and the replay both send such requests at hide, so they draw on
 * one budget here, and what does not fit goes without `keepalive` (or waits) instead of being refused.
 *
 * The state lives on `globalThis`, so a bundler that loads this module twice still has one budget per page.
 */

/** `fetch(..., { keepalive: true })` bodies are limited to 64 KB by browsers; stay under it. */
export const KEEPALIVE_MAX_BYTES = 60_000;

interface KeepaliveState {
  /** UTF-8 bytes of the SDK's keepalive request bodies that have not settled. */
  inflight: number;
  /** What runs first when a page hides: the senders that must get their bytes before the replay does. */
  flushes: Set<() => void>;
}

const SLOT = Symbol.for("codmir.keepalive.budget");

function state(): KeepaliveState {
  const slots = globalThis as Record<symbol, unknown>;
  let current = slots[SLOT] as KeepaliveState | undefined;
  if (!current || typeof current.inflight !== "number" || !(current.flushes instanceof Set)) {
    current = { inflight: 0, flushes: new Set() };
    slots[SLOT] = current;
  }
  return current;
}

/**
 * Takes `bytes` of the budget for one keepalive request. Returns the function that gives them back (call it when the
 * request settles; calling it again does nothing), or `null` when the body does not fit beside the requests in flight.
 */
export function claimKeepalive(bytes: number): (() => void) | null {
  const budget = state();
  if (!(bytes >= 0) || budget.inflight + bytes > KEEPALIVE_MAX_BYTES) return null;
  budget.inflight += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budget.inflight = Math.max(0, budget.inflight - bytes);
  };
}

/** Registers a sender that runs before the replay's hide send, so the error queue gets its bytes first. Returns its unregister function. */
export function onHideFlush(flush: () => void): () => void {
  const { flushes } = state();
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Runs the registered hide senders. Never throws. */
export function runHideFlushes(): void {
  for (const flush of [...state().flushes]) {
    try {
      flush();
    } catch {
      // a sender's failure must not stop the others, or the page
    }
  }
}
