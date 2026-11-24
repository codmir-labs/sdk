/** Level words, shared by the monitor and the line parser. No other import, so both entries stay small. */
import type { LogLevel } from "./types";

// A Map: a level named `constructor` is no level word.
const LEVELS = new Map<string, LogLevel>(Object.entries({
  debug: "debug", trace: "debug", verbose: "debug", silly: "debug",
  info: "info", log: "info", notice: "info",
  warn: "warning", warning: "warning",
  error: "error", err: "error", severe: "error",
  fatal: "fatal", critical: "fatal", emergency: "fatal", crit: "fatal", alert: "fatal", emerg: "fatal", panic: "fatal",
} as const));

/** A level name as one of the five; anything unknown is `info`. */
export function normalizeLevel(level: unknown): LogLevel {
  return (typeof level === "string" && LEVELS.get(level.toLowerCase())) || "info";
}
