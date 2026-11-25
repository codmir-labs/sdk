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
  /** The status this same request was counted with before: a later record of it said worse. That earlier hit is taken back (as far as the open batch holds it). */
  replaces?: number;
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
  cloud: {
    /** Findings handed to the client that sends them. */
    sent: number;
    /** Over the limit of a batch or a day. */
    skipped: number;
    /** Sent this UTC day, for `perDay`. */
    today: number;
    /** Of `sent`, the ones the server did not take, and the reason it gave last (`payment_required`, `status 401`). Known only with `cloud.apiKey`. */
    refused: number;
    reason?: string;
    /** Of `sent`, the ones no answer came for: the client tries again while the process lives. */
    waiting: number;
  };
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
  /** Keeps the findings and marks across a restart: `load()` once when the monitor is made, `save()` at the end of every batch, on `mark()` and in `stop()`. `fileStore(path)` in `@codmir/sdk/logs/node` is one. */
  store?: LogStore;
}

/** Where a monitor keeps its state between runs. Both calls are synchronous; a call that throws, or returns a promise, is counted in `stats().errors` and changes nothing else. */
export interface LogStore {
  /** The state `save()` was last given, as parsed JSON, or anything else (nothing, a broken file) for an empty start. Nothing in it is trusted. */
  load(): unknown;
  save(state: LogState): void;
}

/** What a monitor keeps, as plain JSON. Everything in it went through `redact`; nothing raw is ever in it. */
export interface LogState {
  version: 1;
  /** ISO time of the save. */
  savedAt: string;
  /** The window the `counts` are in. */
  batchMinutes: number;
  /** The groups held. */
  groups: LogStateGroup[];
  marks: LogStateMark[];
  /** The UTC day (`2026-11-24`) and how many findings were sent on it, for `cloud.perDay`. */
  cloud: { day: string; sent: number };
}

export interface LogStateGroup {
  /** The grouping key, `error|the folded message` or `GET|/users/:n|500`. What the group is (kind, level, title, method, path, status, noise) is read back from it, not from the fields next to it; a group whose `id` is not the id of its key is dropped. */
  key: string;
  id: string;
  kind: "request" | "message";
  title: string;
  method?: string;
  path?: string;
  status?: number;
  level?: LogLevel;
  noise: boolean;
  service?: string;
  releases: string[];
  sample: string;
  /** Hits before the batch that was open when the state was saved. */
  total: number;
  /** Hits per batch, the last 96, oldest first. */
  counts: number[];
  /** Epoch milliseconds. */
  firstMs: number;
  lastMs: number;
  backCount: number;
  /** Marked fixed: the next hit is `back`. */
  fixed: boolean;
  known?: string;
  /** User-agent family to count (request groups). */
  families: Record<string, number>;
  nonBot: number;
  pathHits: number;
  scannerHits: number;
  durN: number;
  durSum: number;
  durMax: number;
  /** The judgement of the last batch the group had hits in. */
  last: Judgement;
  /** Cloud: when the group was last sent (epoch ms, 0 if never), the `backCount` and the `total` it was sent at. */
  sentAt: number;
  sentBack: number;
  sentTotal: number;
}

export interface LogStateMark {
  /** A finding's `id`, or whatever `mark()` was given. */
  id: string;
  known?: string;
  fixed?: boolean;
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

/** What `parseLogLine` reads: `auto` decides per line; the others read a line as that format when it fits and as plain text when it does not. */
export type LogFormat = "auto" | "json" | "vercel" | "railway" | "journald" | "pino" | "clf" | "text";

/** One line of an existing log, as the monitor takes it in: a log record or a served request. */
export type ParsedLine = { record: LogRecord } | { request: RequestRecord };
