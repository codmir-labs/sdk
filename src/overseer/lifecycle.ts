/**
 * What an entry's `init` starts, its `close` ends. `init` adds the undo of each listener and patch to a list; `close`
 * runs them, last first. Browser-safe, no Node import. Every helper copes with a global that is missing (React Native,
 * a worker, a server bundle): it does nothing and its undo does nothing.
 */

export type Stop = () => void;

/** The undo functions of what an entry started. */
export class Stops {
  private list: Stop[] = [];

  add(stop: Stop): void {
    this.list.push(stop);
  }

  /** Runs every undo, last first, and empties the list. One that throws does not stop the others. */
  run(): void {
    const list = this.list.reverse();
    this.list = [];
    for (const stop of list) {
      try {
        stop();
      } catch {
        // nothing left to undo for this one
      }
    }
  }
}

/** `target.addEventListener(type, handler, options)` when the target has one; the undo removes it. */
export function listen(target: unknown, type: string, handler: (event: never) => void, options?: AddEventListenerOptions | boolean): Stop {
  const t = target as Partial<EventTarget> | null | undefined;
  if (typeof t?.addEventListener !== "function") return () => {};
  t.addEventListener(type, handler as EventListener, options);
  return () => t.removeEventListener?.(type, handler as EventListener, options);
}

type Fn = (this: unknown, ...args: unknown[]) => unknown;

/** What a patch leaves on the function it installs. A copy of this module, or an older one, only checks that it is there. */
export interface Installed {
  active: boolean;
}

/** Whether `fn` carries a patch (marked with `key`) that is still working: one that closed is `{ active: false }`. */
export function isLive(fn: unknown, key: symbol): boolean {
  const mark = (fn as Record<symbol, unknown> | undefined)?.[key];
  return !!mark && (typeof mark !== "object" || (mark as Installed).active);
}

/**
 * Replaces the method `target[key]` with `wrap(original)`; nothing when it is not a function. The undo puts the original
 * back only when the patch is still on top. When another patch (a second copy of the SDK) was put over it, it stays in
 * the chain and passes every call to the original: restoring would drop the other patch.
 */
export function patch<T extends object, K extends keyof T>(target: T | null | undefined, key: K, wrap: (original: T[K]) => T[K]): Stop {
  const original = target?.[key];
  if (!target || typeof original !== "function") return () => {};
  let working = true;
  const inner = wrap(original) as unknown as Fn;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    return (working ? inner : (original as unknown as Fn)).apply(this, args);
  } as unknown as T[K];
  target[key] = wrapper;
  return () => {
    working = false;
    if (target[key] === wrapper) target[key] = original;
  };
}
