/** A number option: its default when it is not a finite number (`Number(undefined)`), else kept within the limits. */
export const num = (value: unknown, dflt: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : dflt;
