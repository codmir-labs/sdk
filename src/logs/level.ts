/** Level words, shared by the monitor and the line parser. No other import, so both entries stay small. */
import type { LogLevel } from "./types";

const LEVELS: Record<string, LogLevel> = {
  debug: "debug", trace: "debug", verbose: "debug", silly: "debug",
  info: "info", log: "info", notice: "info",
  warn: "warning", warning: "warning",
  error: "error", err: "error", severe: "error",
  fatal: "fatal", critical: "fatal", emergency: "fatal", crit: "fatal", alert: "fatal", emerg: "fatal", panic: "fatal",
};

/** A level name as one of the five; anything unknown is `info`. */
export function normalizeLevel(level: unknown): LogLevel {
  return (typeof level === "string" && LEVELS[level.toLowerCase()]) || "info";
}
