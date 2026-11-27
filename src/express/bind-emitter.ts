/**
 * Makes the listeners of an emitter run in the async context they were added in.
 *
 * A listener on a request or a response runs in the context of whoever emits the event, which is the HTTP parser, not the
 * request. A middleware that continues the chain from such a listener (an upload parser, a `req.on("end")` body reader,
 * a pipe callback) would run the rest of the request with no request scope and no active span.
 */

import { AsyncResource } from "node:async_hooks";

type Listener = (...args: unknown[]) => unknown;
type Method = (this: unknown, event: string | symbol, listener: Listener) => unknown;
type Emitter = Record<string, unknown> & { listenerCount(event: string | symbol): number };

const ADD = ["on", "addListener", "once", "prependListener", "prependOnceListener"];
const REMOVE = ["off", "removeListener"];

/** Emitters already patched, so a second call changes nothing. */
const patched = new WeakSet<object>();

/**
 * Wraps every listener added to `emitter` from now on with `AsyncResource.bind`, while `enabled()` is true. The original
 * listener stays the key: `off` and `removeListener` with it take out the wrapper, and `once` still fires once.
 */
export function bindEmitter(emitter: object, enabled: () => boolean): void {
  const e = emitter as Emitter;
  if (patched.has(e) || typeof e.on !== "function") return;
  patched.add(e);

  // original listener -> its wrappers by event, the newest last
  const wrappers = new WeakMap<Listener, Map<string | symbol, Listener[]>>();
  // Node's `once` and `prependOnce` call `this.on` and `this.prependListener` themselves: wrap only the outermost call.
  let inside = false;

  for (const name of ADD) {
    const original = e[name] as Method | undefined;
    if (typeof original !== "function") continue;
    e[name] = function (this: unknown, event: string | symbol, listener: Listener) {
      if (inside || typeof listener !== "function" || !enabled()) return original.call(this, event, listener);
      const bound = AsyncResource.bind(listener) as Listener;
      let byEvent = wrappers.get(listener);
      if (!byEvent) wrappers.set(listener, (byEvent = new Map()));
      byEvent.set(event, [...(byEvent.get(event) ?? []), bound]);
      inside = true;
      try {
        return original.call(this, event, bound);
      } finally {
        inside = false;
      }
    };
  }

  for (const name of REMOVE) {
    const original = e[name] as Method | undefined;
    if (typeof original !== "function") continue;
    e[name] = function (this: unknown, event: string | symbol, listener: Listener) {
      const list = typeof listener === "function" ? wrappers.get(listener)?.get(event) : undefined;
      // The newest wrapper still attached goes first, as Node removes the newest copy of a listener.
      for (let i = (list?.length ?? 0) - 1; list && i >= 0; i--) {
        const before = e.listenerCount(event);
        const result = original.call(this, event, list[i] as Listener);
        list.splice(i, 1);
        if (e.listenerCount(event) < before) return result;
      }
      return original.call(this, event, listener);
    };
  }
}
