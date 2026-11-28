/**
 * The two `globalThis` flags of the page listeners, and the one call that ends whatever they hold. No imports: the core
 * `close` uses it, and `page-errors.ts` imports the core, so the keys cannot live there.
 */

/** What a flag holds: how to end its listener, and the checks of the entries that asked to leave some errors out. */
export interface PageSlot {
  stop: () => void;
  skips: Array<(value: unknown) => boolean>;
}

export const FLAG_ERROR = Symbol.for("codmir.page-errors.error");
export const FLAG_REJECTION = Symbol.for("codmir.page-errors.unhandledrejection");

/**
 * Removes the page listeners any entry installed and frees both flags, so a later `init` of any entry installs its own.
 * A flag an older copy of the SDK set (not a `PageSlot`) is left alone. Safe to call twice; never throws.
 */
export function stopPageErrors(): void {
  const slots = globalThis as Record<symbol, unknown>;
  for (const flag of [FLAG_ERROR, FLAG_REJECTION]) {
    const slot = slots[flag] as Partial<PageSlot> | undefined;
    if (typeof slot?.stop !== "function") continue;
    try {
      slot.stop();
    } catch {
      // nothing left to undo for this one
    }
    if (slots[flag] === slot) delete slots[flag];
  }
}
