/**
 * @codmir/sdk/logs: findings from an app's own logs.
 *
 * ```ts
 * import { createLogMonitor } from "@codmir/sdk/logs";
 *
 * const logs = createLogMonitor({ onBatch: (b) => console.log(b.findings) });
 * logs.record({ level: "error", message: "payment failed for order 8812" });
 * logs.request({ method: "GET", path: "/users/42", status: 500, durationMs: 31 });
 * ```
 *
 * Local by default: no account, no network. `cloud: true` sends the findings to a Codmir project as issues.
 */
export { createLogMonitor, normalizeLevel } from "./monitor";
export { redact, pathPattern, messageKey, uaFamily, isScannerPath } from "./redact";
export type {
  CloudOptions,
  Finding,
  Judgement,
  LogBatch,
  LogLevel,
  LogMonitor,
  LogMonitorOptions,
  LogRecord,
  MarkOptions,
  MonitorStats,
  RequestRecord,
  TimeInput,
} from "./types";
