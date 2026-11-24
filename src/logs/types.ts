/** Public types of `@codmir/sdk/logs`. */

export type LogLevel = "debug" | "info" | "warning" | "error" | "fatal";

/**
 * What the monitor made of a finding in a batch:
 * - `new` seen for the first time;
 * - `alarm` a request of status 500 or above or a fatal line with 3 or more hits in the batch, or 10 times its usual;
 * - `back` seen again after 24 quiet hours, or after `mark(id, { fixed: true })`;
 * - `known` marked with `mark(id, { known })`;
 * - `noise` a scanner probe or one of your own noise patterns;
 * - `seen` an ordinary repeat.
 */
export type Judgement = "new" | "alarm" | "back" | "known" | "noise" | "seen";

export type TimeInput = number | string | Date;

export interface LogRecord {
  level: LogLevel | string;
  message: string;
  time?: TimeInput;
  /** The request path the line was logged under, if any. Kept as a pattern; used to spot scanner noise. */
  path?: string;
  release?: string;
  service?: string;
}

export interface RequestRecord {
  method: string;
  path: string;
  status: number;
  durationMs?: number;
  /** Reduced to a family (browser, bot, node, curl, other) on arrival; the string is never kept. */
  userAgent?: string;
  time?: TimeInput;
  release?: string;
  service?: string;
}

export interface Finding {
  /** 8 hex characters, stable for the same group. What `mark()` takes. */
  id: string;
  /** The grouping key, at most 200 characters. */
  key: string;
  kind: "request" | "message";
  /** `GET /users/:n answers 500` for a request, the folded message for a log line. At most 200 characters. */
  title: string;
  judgement: Judgement;
  /** Hits in the current batch (in `findings()`) or in the batch that was judged (in `onBatch`). */
  hits: number;
  /** Hits since the monitor started (or since the group was last dropped). */
  total: number;
  /** Hits per batch, oldest first, the last 96. In `onBatch` the last entry is the batch just ended. */
  counts: number[];
  /** ISO times. */
  firstSeen: string;
  lastSeen: string;
  releases: string[];
  service?: string;
  /** One redacted example, at most 300 characters. */
  sample: string;
  method?: string;
  path?: string;
  status?: number;
  level?: LogLevel;
  /** Request groups: user-agent family to count. */
  families?: Record<string, number>;
  /** Request groups: mean and largest duration in ms, when `durationMs` was given. */
  avgMs?: number;
  maxMs?: number;
  /** The note or URL given to `mark(id, { known })`. */
  known?: string;
  /** How many times it came back. */
  backCount: number;
}

export interface LogBatch {
  /** ISO time the window started and ended. */
  from: string;
  to: string;
  /** Every record that arrived in the window, findings or not. */
  records: number;
  /** The groups that had hits in the window, each judged. */
  findings: Finding[];
  /** The ones judged `alarm`. */
  alarms: Finding[];
}

export interface MonitorStats {
  /** Every call to `record` and `request` that was taken in. */
  records: number;
  /** Taken in but below the finding threshold (info lines, status under 400): counted only. */
  ignored: number;
  /** Groups held now. */
  groups: number;
  /** Groups dropped because `limits.groups` was reached. */
  dropped: number;
  batches: number;
  /** Calls skipped because the monitor was busy delivering a batch (an app that logs inside `onBatch`). */
  reentrant: number;
  /** Errors thrown by `onBatch` or by an internal step, swallowed. */
  errors: number;
  cloud: { sent: number; skipped: number; today: number };
}

export interface CloudOptions {
  /** A project key. Without it, `cloud: true` is needed and the client `init()` made is used. */
  apiKey?: string;
  /** Ingest endpoint; default the SDK's own. */
  dsn?: string;
  /** Lowest level sent: `warning` (default), `error` or `fatal`. A request below 500 is `warning`. */
  minSeverity?: "warning" | "error" | "fatal";
  /** A finding with hits is sent again after this many minutes, not sooner. Default 60. */
  everyMinutes?: number;
  /** Findings sent per batch, most serious first. Default 50. */
  perBatch?: number;
  /** Findings sent per UTC day. Default 1000. */
  perDay?: number;
  environment?: string;
}

export interface LogMonitorOptions {
  service?: string;
  release?: string;
  /** Minutes between batches. Default 15. */
  batchMinutes?: number;
  /** What becomes a finding. Default: warning, error and fatal lines, and status 400 and above. */
  include?: { levels?: LogLevel[]; minStatus?: number };
  /** Your own noise: a string is a substring (case-insensitive), a RegExp is tested, against `GET /path 404` or `ERROR the folded message`. */
  noise?: Array<string | RegExp>;
  /** Your own redaction patterns; every match becomes `[redacted]`. Applied before the built-in ones. */
  redact?: RegExp[];
  limits?: { groups?: number };
  onBatch?: (batch: LogBatch) => void;
  cloud?: boolean | CloudOptions;
}

export interface MarkOptions {
  /** A note or URL; the finding is judged `known`. `false` clears it. */
  known?: string | false;
  /** The next hit after this is judged `back`. */
  fixed?: boolean;
}

export interface LogMonitor {
  record(rec: LogRecord): void;
  request(req: RequestRecord): void;
  /** The groups now: those with hits in the open batch judged as they stand, the others as the last batch left them. */
  findings(): Finding[];
  /** `id` is a finding's `id` or its `key`. A mark made before the finding exists applies when it appears. Returns whether the finding exists now. */
  mark(id: string, options: MarkOptions): boolean;
  /** Ends the open batch now: judges, calls `onBatch`, sends to Codmir in cloud mode. Resolves when the sending is done; never rejects. */
  flush(): Promise<void>;
  /** Flushes once more, stops the timer, ignores later records. Never rejects. */
  stop(): Promise<void>;
  stats(): MonitorStats;
}
