/**
 * An internal note an integration attaches to the context it passes to `captureException`: how the error reached the
 * SDK (its mechanism, and whether the app handled it) and, optionally, its level. It rides under a registry symbol, so
 * it works across the copies of this module a bundler makes, and `Object.entries` never sees it: it can not reach `extra`.
 * Not part of the public API; a caller's own `handled` or `mechanism` keys stay plain data.
 */
export const CAPTURE_HINT = Symbol.for("codmir.capture.hint");

export interface CaptureHint {
  mechanism: { type: string; handled: boolean };
  level?: "fatal" | "error" | "warning" | "info" | "debug";
}

const LEVELS = new Set(["fatal", "error", "warning", "info", "debug"]);

/** `context` with the hint attached; the other keys are kept as they are. */
export function withHint(context: Record<string, unknown> | undefined, hint: CaptureHint): Record<string, unknown> {
  return { ...context, [CAPTURE_HINT]: hint };
}

/** The hint on a context, checked field by field; `undefined` when there is none or it is malformed. */
export function readHint(context: Record<string, unknown> | undefined): CaptureHint | undefined {
  const raw = context ? (context as Record<symbol, unknown>)[CAPTURE_HINT] : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const { mechanism, level } = raw as { mechanism?: { type?: unknown; handled?: unknown }; level?: unknown };
  if (!mechanism || typeof mechanism.type !== "string" || typeof mechanism.handled !== "boolean") return undefined;
  return {
    mechanism: { type: mechanism.type, handled: mechanism.handled },
    ...(typeof level === "string" && LEVELS.has(level) ? { level: level as CaptureHint["level"] } : {}),
  };
}

/** An unhandled crash: `handled: false` under the integration's own mechanism name. */
export function crash(type: string, level?: CaptureHint["level"]): CaptureHint {
  return { mechanism: { type, handled: false }, ...(level ? { level } : {}) };
}
