/**
 * Reads one line of a log an app already has (JSON lines, a hosting platform's output, the system journal, pino, a web
 * server's access log, plain text) as what the monitor takes in. No Node import, never throws, and bounded: a line
 * is cut to 64 KB first, JSON nested deeper than 20 levels is text, and every pattern is linear (the longest runs of a
 * pattern are bounded or made of one character class). Nothing is redacted here: the monitor does that before keeping anything.
 */
import { normalizeLevel } from "./level";
import type { LogFormat, LogLevel, LogRecord, ParsedLine, RequestRecord } from "./types";

export const MAX_LINE = 65536;
const MAX_DEPTH = 20;
const MAX_TEXT = 2000;
const MAX_ITEMS = 1000;
/** How far into a line `key=value` pairs are looked for. */
const MAX_PAIRS = 4096;
/** A line inside a line inside a line (a journal entry of a container's JSON): as deep as it goes. */
const MAX_WRAP = 3;

type Obj = Record<string, unknown>;
/** What a line gives: one thing, several (a drain's record can give its request and its text), or nothing. */
type Out = ParsedLine | ParsedLine[] | null;
const first = (x: Out): ParsedLine | null => (Array.isArray(x) ? (x[0] ?? null) : x);
type Pick<T> = (v: unknown) => T | undefined;
interface About {
  time?: number;
  service?: string;
  release?: string;
}
/** What the thing around a line knows about it. */
interface Base {
  /** The level when the line names none of its own. */
  level?: LogLevel;
  service?: string;
  release?: string;
  path?: string;
  time?: number;
  /** `service`, `release` and `time` win over the line's own (the journal's are the truth). */
  over?: boolean;
  /** The platform logs the request itself: one inside a line would count twice. */
  noRequest?: boolean;
  /** The message of the object is a line of its own: the object's level is the stream's, not the line's. */
  wraps?: boolean;
  depth?: number;
}

const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str: Pick<string> = (v) => (typeof v === "string" && v.trim() ? v : undefined);
const name: Pick<string> = (v) => (typeof v === "string" && v.trim() ? v.slice(0, 64) : undefined);
/** Key paths: `req.method` is the key of that name (`{"req.method": …}`) or the nested one (`{"req": {"method": …}}`). */
const P = (s: string): string[][] => s.split(" ").map((p) => (p.includes(".") ? [p, ...p.split(".")] : [p]));
const find = <T>(o: Obj, paths: string[][], as: Pick<T>): T | undefined => {
  for (const path of paths) {
    let r = as(own(o, path[0]));
    if (r === undefined && path.length > 1) {
      let v: unknown = o;
      for (let i = 1; i < path.length; i++) v = obj(v) ? own(v as Obj, path[i]) : undefined;
      r = as(v);
    }
    if (r !== undefined) return r;
  }
  return undefined;
};
const done = <T extends object>(o: T): T => {
  for (const k of Object.keys(o)) if ((o as Obj)[k] === undefined) delete (o as Obj)[k];
  return o;
};

const LEVEL = P("level severity lvl log.level levelname loglevel log_level severityText Level LogLevel @l");
const MESSAGE = P("message msg event message.errorMessage message.message errorMessage Message @m");
const TIME = P("time timestamp ts @timestamp asctime datetime Timestamp @t");
const SERVICE = P("service service.name dd.service name logger logger_name kubernetes.container_name");
const RELEASE = P("release version service.version dd.version");
const METHOD = P("method req.method httpRequest.requestMethod request.method http.request.method http.method request_method");
const URL_ = P("path url req.url httpRequest.requestUrl request.url request.uri url.path url.full http.target http.url request_uri uri");
const STATUS = P("status statusCode res.statusCode httpRequest.status response.status http.response.status_code http.status_code status_code");
const DURATION = P("durationMs duration_ms duration responseTime elapsed");
const AGENT = P("userAgent user_agent user_agent.original http_user_agent httpRequest.userAgent req.headers.user-agent request.headers.user-agent request.headers.User-Agent");

const ANSI = /\x1b\[[0-9;?]{0,20}[ -/]?[@-~]/g; // eslint-disable-line no-control-regex
const plain = (s: string): string => (s.includes("\x1b") ? s.replace(ANSI, "") : s);

const ORDER: LogLevel[] = ["debug", "info", "warning", "error", "fatal"];
const worse = (a: LogLevel, b: LogLevel | undefined): LogLevel => (b && ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a);

/** A level word, a pino number (10 trace to 60 fatal) or a digit string of one. */
const level: Pick<LogLevel> = (v) => {
  if (typeof v === "string") {
    if (!/^\d{1,3}$/.test(v)) return v ? normalizeLevel(plain(v)) : undefined;
    v = +v;
  }
  return typeof v === "number" && v >= 10 ? (v >= 60 ? "fatal" : v >= 50 ? "error" : v >= 40 ? "warning" : v >= 30 ? "info" : "debug") : undefined;
};

/** A date with a time, as most loggers write it; a zone is optional and UTC when it is not there. */
const STAMP = /^\[?(?:(?:time|ts|timestamp)=["']?)?(\d{4})[-/](\d\d)[-/](\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?(?:(Z|[+-]\d\d(?::?\d\d)?(?!\d))| (UTC\b|GMT\b|[+-]\d\d:?\d\d(?!\d)))?["']?\]?[\s:|-]*/;
function stamp(m: RegExpExecArray): number | undefined {
  const z = m[8] ?? m[9];
  const off = z && /^[+-]/.test(z) ? (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 60 + +(z.replace(":", "").slice(3, 5) || 0)) : 0;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] ?? "0").slice(0, 3).padEnd(3, "0")) - off * 60_000;
  return Number.isFinite(at) ? at : undefined;
}
const ZONED = /(?:Z|UTC|GMT|[+-]\d\d:?\d\d)(?: ?\([^()]{0,60}\))?$/;

/** Epoch milliseconds from a time in any of the common shapes: seconds, milliseconds, microseconds or nanoseconds by size, or a date string (UTC when it names no zone). */
const time: Pick<number> = (v) => {
  let n = NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    if (!/^\d{1,19}(?:\.\d{1,9})?$/.test(v)) {
      const t = v.slice(0, 80).trim();
      const s = STAMP.exec(t);
      n = s && s[0].length === t.length ? (stamp(s) ?? NaN) : ZONED.test(t) ? NaN : Date.parse(`${t} UTC`);
      if (Number.isNaN(n)) n = Date.parse(t);
      return n > 0 && n < 8.64e15 ? n : undefined;
    }
    n = +v;
  }
  if (!(n > 0) || !Number.isFinite(n)) return undefined;
  const ms = n < 1e11 ? n * 1000 : n < 1e14 ? n : n < 1e17 ? n / 1000 : n / 1e6;
  return ms < 8.64e15 ? Math.round(ms) : undefined;
};

const status: Pick<number> = (v) => {
  const n = typeof v === "string" && /^\d{3}$/.test(v) ? +v : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
};
const method: Pick<string> = (v) => (typeof v === "string" && /^[A-Za-z]{3,10}$/.test(v) ? v.toUpperCase() : undefined);
const ms: Pick<number> = (v) => {
  const n = typeof v === "string" && /^\d{1,12}(?:\.\d{1,6})?$/.test(v) ? +v : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
const agent: Pick<string> = (v) => str(Array.isArray(v) ? v[0] : v)?.slice(0, 300);

/** The path of a URL or path: no origin (and so no user and password), no query, no fragment. */
const path: Pick<string> = (v) => {
  let s = typeof v === "string" ? v.slice(0, 600).trim() : "";
  if (!s) return undefined;
  const origin = /^[a-z][a-z0-9+.-]{0,20}:\/\/[^/?#]*/i.exec(s);
  if (origin) s = s.slice(origin[0].length);
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  return s.slice(0, 500) || "/";
};

const isBad = (l: LogLevel | string): boolean => l === "warning" || l === "error" || l === "fatal";
const message = (s: string): string => plain(s.slice(0, 2 * MAX_TEXT)).slice(0, MAX_TEXT);

/** Parsed JSON that is not nested deeper than 20 levels; undefined for anything else. */
function jsonValue(t: string): unknown {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 || c === 91) {
      if (++depth > MAX_DEPTH) return undefined;
    } else if (c === 125 || c === 93) depth--;
  }
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const jsonObject = (t: string): Obj | undefined => (t.charCodeAt(0) === 123 ? obj(jsonValue(t)) : undefined);

/** The time, service and release a line gets: its own, unless the wrapper's are the truth. */
const about = (base: Base, t?: number, service?: string, release?: string): About =>
  base.over
    ? { time: base.time ?? t, service: base.service ?? service, release: base.release ?? release }
    : { time: t ?? base.time, service: service ?? base.service, release: release ?? base.release };

/** A line inside another one (a journal's MESSAGE, a container's `log`, a platform's `message`): its own level when it names one, else the wrapper's. */
function inner(raw: string, base: Base): ParsedLine | null {
  const line = raw.slice(0, MAX_LINE);
  const t = line.trim();
  if (!t) return null;
  const depth = (base.depth ?? 0) + 1;
  const b: Base = { ...base, wraps: false, depth };
  const o = depth <= MAX_WRAP ? jsonObject(t) : undefined;
  const parsed = (o && fromObject(o, b)) ?? (!b.noRequest && CLF_START.test(t) ? clf(t, b) : null);
  return parsed ?? (o ? record(b, b.level ?? "info", t) : first(text(line, b)));
}

const record = (base: Base, lv: LogLevel, msg: string, t?: number): ParsedLine => ({
  record: done<LogRecord>({ level: lv, message: message(msg), path: base.path, ...about(base, t) }),
});

/** A JSON object of any of the common shapes: a record, or a request when it carries a method, a path and a status. */
function fromObject(o: Obj, base: Base = {}): ParsedLine | null {
  const e = obj(own(o, "err")) ?? obj(own(o, "error"));
  const named = find(o, LEVEL, level);
  const lv = named ?? (e || str(own(o, "error")) ? worse("error", base.level) : (base.level ?? "info"));
  const at = about(base, find(o, TIME, time), find(o, SERVICE, name), find(o, RELEASE, name));
  const m = find(o, METHOD, method);
  const p = find(o, URL_, path) ?? base.path;
  const code = find(o, STATUS, status);
  if (m && p && code && !base.noRequest && !(code < 400 && (lv === "error" || lv === "fatal"))) {
    return { request: done<RequestRecord>({ method: m, path: p, status: code, durationMs: find(o, DURATION, ms), userAgent: find(o, AGENT, agent), ...at }) };
  }
  let msg = find(o, MESSAGE, str);
  const wrapped = msg ? undefined : str(own(o, "log"));
  const em = e ? str(own(e, "message")) : undefined;
  const et = e ? (str(own(e, "type")) ?? str(own(e, "name")) ?? str(own(e, "code"))) : undefined;
  const why = e ? (em ? (et ? `${et}: ${em}` : em) : et) : (str(own(o, "error")) ?? str(own(o, "err")));
  if (!why && (wrapped || (msg && base.wraps))) return inner((wrapped ?? msg) as string, { ...base, ...at, level: named ?? base.level, path: p });
  if (why && !msg?.includes(em ?? why)) msg = msg ? `${msg}: ${why}` : why;
  if (!msg) return null;
  return { record: done<LogRecord>({ level: lv, message: message(msg), path: p, ...at }) };
}

const PRIORITY: LogLevel[] = ["fatal", "fatal", "fatal", "error", "warning", "info", "info", "debug"];

/** `journalctl -o json`: PRIORITY 0 to 7, MESSAGE as a string, an array of bytes or null. */
function journald(o: Obj): ParsedLine | null {
  if (!("MESSAGE" in o) && !("PRIORITY" in o)) return fromObject(o);
  const raw = own(o, "MESSAGE");
  let line = "";
  if (typeof raw === "string") line = raw;
  else if (Array.isArray(raw) && raw.length <= MAX_LINE && raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) line = new TextDecoder().decode(Uint8Array.from(raw as number[]));
  const p = Number(own(o, "PRIORITY") ?? NaN);
  const unit = str(own(o, "_SYSTEMD_USER_UNIT")) ?? str(own(o, "_SYSTEMD_UNIT"));
  const service = (unit ? name(unit.replace(/\.service$/, "")) : undefined) ?? name(own(o, "SYSLOG_IDENTIFIER")) ?? name(own(o, "_COMM"));
  return inner(line, { level: Number.isInteger(p) ? PRIORITY[p] : undefined, service, time: time(own(o, "__REALTIME_TIMESTAMP")), over: true });
}

/** Railway's JSON lines: `attributes` carries the fields of a structured log; without a level there, `severity` is the stream's. */
function railway(o: Obj): ParsedLine | null {
  const a = obj(own(o, "attributes"));
  const merged: Obj = Object.create(null);
  for (const [src, skip] of [[a, ""], [o, "attributes"]] as const) {
    if (src) for (const k of Object.keys(src)) if (k !== skip) merged[k] = src[k];
  }
  const structured = a !== undefined && level(own(a, "level")) !== undefined;
  if (structured) merged.level = own(a, "level");
  return fromObject(merged, { wraps: !structured });
}

const V_TIME = P("timestamp timestampInMs");
const V_METHOD = P("requestMethod method");
const V_PATH = P("requestPath path");
const V_STATUS = P("httpStatus responseStatusCode statusCode");
const V_MESSAGE = P("message");
const V_ENV = P("environment");
const V_SOURCE = P("source");
const V_RELEASE = P("deploymentId");
const V_AGENT = P("clientUserAgent");
const CONSOLE = new Set(["stdout", "stderr", "fatal"]);
const PLATFORM = new Set(["report", "delimiter", "metrics", "middleware-invocation", "edge-function-invocation"]);
const WAF = new Set(["challenge", "deny", "rate_limit"]);
const SUMMARY_LINE = /^\[[A-Za-z]{3,10}\] \S{1,2000} status=-?\d{1,3}$/;
const MAX_IDS = 5000;
const MAX_ID = 128;

/** The request ids of a drain seen so far (the last 5,000, in order) and the worst status each was counted with. Ids are never kept anywhere else. */
export class Seen {
  private readonly ids = new Map<string, number>();
  get(id: string): number | undefined {
    return this.ids.get(id);
  }
  set(id: string, status: number): void {
    if (!this.ids.has(id) && this.ids.size >= MAX_IDS) this.ids.delete(this.ids.keys().next().value as string);
    this.ids.set(id, status);
  }
}
let current: Seen | undefined;

/** A drain message without the platform's own lines (an invocation's start, end, report and summary); undefined when nothing is left. */
function appText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.slice(0, MAX_LINE);
  if (!/RequestId: |INIT_START | status=/.test(t)) return t;
  const keep: string[] = [];
  for (let i = 0; i <= t.length; ) {
    let j = t.indexOf("\n", i);
    if (j < 0) j = t.length;
    const l = t.slice(i, j);
    i = j + 1;
    if (/^(?:(?:START|END|REPORT) RequestId: |INIT_START )/.test(l) || (l.length < 2100 && SUMMARY_LINE.test(l.trim()))) continue;
    keep.push(l);
  }
  return str(keep.join("\n"));
}

/**
 * Vercel: the CLI's `{ type, data }` lines, a log drain's record and the older CLI's flat line. A drain record gives its
 * request (once per `requestId`, with the worse status if a later record of it has one) and its text, each or none.
 */
function vercel(o: Obj): ParsedLine[] {
  const type = own(o, "type");
  if (type === "summary" || own(o, "status") === "error") return [];
  const data = (type === "request" || type === "log") && obj(own(o, "data"));
  const d = data || o;
  const proxy = obj(own(d, "proxy"));
  const px = (k: string): unknown => (proxy ? own(proxy, k) : undefined);
  // The older CLI's flat line is not a drain's record: it keeps the old reading (a request, or the text when that is the worse news).
  const drain = !data && !("requestMethod" in o || "requestPath" in o || "responseStatusCode" in o || "httpStatus" in o);
  const source = own(d, "source");
  if (drain && (source === "firewall" || source === "build" || WAF.has(px("wafAction") as string))) return [];
  const at = find(d, V_TIME, time) ?? time(px("timestamp"));
  const pm = method(px("method"));
  const pp = path(px("path"));
  const m = drain ? (pm ?? find(d, V_METHOD, method)) : (find(d, V_METHOD, method) ?? pm);
  const p = drain ? (pp ?? find(d, V_PATH, path)) : (find(d, V_PATH, path) ?? pp);
  const pcode = status(px("statusCode"));
  // `statusCode: -1` is no answer (the function crashed): 500, or what the visitor got; `proxy.statusCode: -1` is a revalidation in the background.
  const code = drain && px("statusCode") === -1 ? undefined : (find(d, V_STATUS, status) ?? (drain && own(d, "statusCode") === -1 ? (pcode ?? 500) : pcode));
  const service = [find(d, V_ENV, name), find(d, V_SOURCE, name)].filter(Boolean).join(" ").slice(0, 64) || undefined;
  const release = find(d, V_RELEASE, name);
  let req: ParsedLine | null =
    m && p && code ? { request: done<RequestRecord>({ method: m, path: p, status: code, userAgent: find(d, V_AGENT, agent) ?? agent(px("userAgent")), time: at, release, service }) } : null;
  if (req && drain) {
    const id = own(d, "requestId");
    if (typeof id === "string" && id.length > 0 && id.length <= MAX_ID) {
      const seen = (current ??= new Seen());
      const before = seen.get(id);
      if (before === undefined || (code as number) > before) {
        seen.set(id, code as number);
        if (before !== undefined) (req as { request: RequestRecord }).request.replaces = before;
      } else req = null;
    } else if (typeof type === "string" && CONSOLE.has(type)) req = null;
  }
  if (type === "request") return req ? [req] : [];
  // The level is the stream's (`console.error` gives error): a line of a JSON logger, or one that starts with a level, says it better.
  const found = find(d, V_MESSAGE, str);
  const line = drain ? (typeof type === "string" && PLATFORM.has(type) ? undefined : appText(found)) : found;
  const rec = line ? inner(line, { level: find(d, LEVEL, level) ?? (type === "fatal" ? "fatal" : undefined), time: at, service, release, path: p, over: true, noRequest: true }) : null;
  if (drain) return [req, rec].filter((x): x is ParsedLine => !!x);
  if (type === "log" || !req) return rec ? [rec] : [];
  return [rec && "record" in rec && (code as number) < 500 && isBad(rec.record.level) ? rec : req];
}

/** Apache and nginx Common and Combined Log Format, with a host name first or not. The client address, the user and the referer are never kept. */
const CLF = /^(?:[^ ]{1,255} ){3,4}\[([^\]]{20,30})\] "([A-Za-z]{3,10}) ([^" ]{1,2000})(?: [^"]{0,20})?" (\d{3}) (?:\d+|-)(?: "[^"]{0,2000}" "([^"]{0,500})")?/;
const CLF_START = /^(?:[^ ]{1,255} ){3,4}\[\d{1,2}\/[A-Za-z]{3}\/\d{4}:/;
const CLF_TIME = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d\d)(\d\d)$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** `10/Oct/2000:13:55:36 -0700` as epoch milliseconds. */
function clfTime(v: string): number | undefined {
  const m = CLF_TIME.exec(v);
  const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || mon < 0) return undefined;
  const sign = m[7][0] === "-" ? -1 : 1;
  const at = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) - (+m[7] * 60 + sign * +m[8]) * 60_000;
  return Number.isFinite(at) ? at : undefined;
}
function clf(t: string, base: Base = {}): ParsedLine | null {
  const m = CLF.exec(t);
  const code = m && status(m[4]);
  if (!m || !code) return null;
  return { request: done<RequestRecord>({ method: m[2].toUpperCase(), path: path(m[3]) ?? "/", status: code, userAgent: m[5] && m[5] !== "-" ? m[5] : undefined, ...about(base, clfTime(m[1])) }) };
}

const WORDS = "TRACE|DEBUG|VERBOSE|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE|PANIC|ALERT|EMERGENCY|EMERG";
// `[error]`, and Apache's `[proxy:error]`.
const BRACKETED = new RegExp(`[\\[(<]\\s*(?:[\\w.-]{1,30}:)?(${WORDS})\\s*[\\])>]`, "i");
const UPPER = new RegExp(`(?:^|[^A-Za-z0-9_])(${WORDS})(?![A-Za-z0-9_])`);
const COLONED = new RegExp(`(?:^|\\s)(${WORDS})\\s*:`, "i");
const KV_LEVEL = /(?:^|\s)(?:level|lvl|severity)=["']?([A-Za-z]{3,9})/i;
const kv = (keys: string): RegExp => new RegExp(`(?:^|\\s)(?:${keys})=(?:"((?:[^"\\\\]|\\\\.){0,1000})"|([^\\s"]{1,1000}))`);
const KV_MSG = kv("msg|message");
const KV_METHOD = kv("method");
const KV_PATH = kv("path|uri|url");
const KV_STATUS = kv("status|status_code");
const kvOf = (re: RegExp, t: string): string | undefined => {
  const m = re.exec(t);
  return m ? (m[1] ?? m[2]).replace(/\\(.)/g, "$1") : undefined;
};
const ANDROID = /^([VDIWEF])\/[\w.$-]{1,60}/;
const GLOG = /^([IWEF])\d{4} \d\d:\d\d:\d\d/;
const SHORT: Record<string, LogLevel> = { V: "debug", D: "debug", I: "info", W: "warning", E: "error", F: "fatal" };
const BRACKET_STAMP = /^\[([^\]]{4,40})\]\s*/;
const BSD_STAMP = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d) /;
const NEST = /^\[Nest\] \d{1,10}\s{1,8}-\s{1,8}(\d\d)\/(\d\d)\/(\d{4}), (\d{1,2}):(\d\d):(\d\d) ([AP])M\s{1,20}/;
// What syslog, or the thing that runs a container, writes before the line: `host app[123]: `, `stderr F `.
const BSD_HOST = /^[\w.-]{1,255} ([\w./@-]{1,64})(?:\[\d{1,10}\])?: /;
const ISO_HOST = /^[\w.-]{1,255} ([\w./@-]{1,64})\[\d{1,10}\]: /;
const CRI = /^(?:stdout|stderr) [FP] /;
const STACK = /^(?:\s+at\s|\s*Caused by:|\s*\.\.\. \d+ (?:more|common)|\s+File ".{0,500}", line \d|Traceback \(most recent call last\))/;
const PROMPT = /^(?:\S{1,60}\s)?\S{0,60}[$#%>]$/;
// `TypeError: …`, `java.lang.IllegalStateException`, `Error [ERR_X]: …`, `Uncaught Exception: …`: an exception's name says what the line is.
const EXCEPTION = /^(?:(?:Uncaught|Unhandled) )?(?:Exception in thread "[^"]{0,100}" )?[\w$.]{0,160}(?:Error|Exception)(?: \[[\w.-]{1,60}\])?(?::|$)/;
const UNHANDLED = /^(?:unhandled ?(?:promise ?)?rejection|uncaught ?exception)\b/i;
const PANICKED = /^thread '[^']{0,100}' (?:\(\d{1,10}\) )?panicked at\b/;

/** The time of a BSD syslog line, which names no year: the last one that makes it not lie in the future. */
function bsdTime(m: RegExpExecArray): number {
  const now = Date.now();
  const of = (year: number): number => Date.UTC(year, MONTHS.indexOf(m[1].toLowerCase()), +m[2], +m[3], +m[4], +m[5]);
  const year = new Date(now).getUTCFullYear();
  return of(year) > now + 36 * 3_600_000 ? of(year - 1) : of(year);
}

/** Plain text: a leading time, a level word near the start, and a stack-trace line (which belongs to the line before it) is nothing. */
function text(raw: string, base: Base = {}): Out {
  const line = plain(raw);
  if (STACK.test(line)) return null;
  let rest = line.trim();
  if (!rest || (rest.length <= 130 && PROMPT.test(rest))) return null;
  let at: number | undefined;
  let service: string | undefined;
  const s = STAMP.exec(rest);
  const bsd = s ? null : BSD_STAMP.exec(rest);
  const nest = s || bsd ? null : NEST.exec(rest);
  if (s || bsd) {
    at = s ? stamp(s) : bsdTime(bsd as RegExpExecArray);
    rest = rest.slice((s ?? (bsd as RegExpExecArray))[0].length).replace(CRI, "");
    const host = (s ? ISO_HOST : BSD_HOST).exec(rest);
    if (host) {
      service = host[1];
      rest = rest.slice(host[0].length);
    }
  } else if (nest) {
    at = Date.UTC(+nest[3], +nest[1] - 1, +nest[2], (+nest[4] % 12) + (nest[7] === "P" ? 12 : 0), +nest[5], +nest[6]);
    rest = rest.slice(nest[0].length);
  } else {
    const b = BRACKET_STAMP.exec(rest);
    if (b && /\d\d:\d\d/.test(b[1])) {
      const p = clfTime(b[1]) ?? time(b[1]);
      if (p !== undefined) {
        at = p;
        rest = rest.slice(b[0].length);
      }
    }
  }
  if (STACK.test(rest)) return null;
  const depth = base.depth ?? 0;
  const o = depth <= MAX_WRAP ? jsonObject(rest) : undefined;
  if (o) return route(o, "auto", { ...base, ...about(base, at, service), depth: depth + 1 });
  const b: Base = { ...base, ...about(base, at, service) };
  const pairs = rest.slice(0, MAX_PAIRS);
  if (!b.noRequest && pairs.includes("status=") && pairs.includes("method=")) {
    const m = method(kvOf(KV_METHOD, pairs));
    const p = path(kvOf(KV_PATH, pairs));
    const code = status(kvOf(KV_STATUS, pairs));
    if (m && p && code) return { request: done<RequestRecord>({ method: m, path: p, status: code, ...about(b) }) };
  }
  const head = rest.slice(0, 60);
  let lv: LogLevel | undefined;
  // Whether the level is a mark of its own (`[info]`, `level=info`, the first word): then it stands against the wrapper's too.
  let sure = true;
  let cut: [number, number] | undefined;
  const kvl = KV_LEVEL.exec(head);
  if (kvl) {
    lv = normalizeLevel(kvl[1]);
    rest = kvOf(KV_MSG, pairs) ?? rest;
  } else {
    const a = ANDROID.exec(head);
    const g = a ? null : GLOG.exec(head);
    let m: RegExpExecArray | null;
    if (a || g) {
      lv = SHORT[(a ?? (g as RegExpExecArray))[1]];
      const end = g ? rest.indexOf("] ", 14) : -1;
      if (a) cut = [0, 2];
      else if (end > 0 && end < 120) cut = [0, end + 2];
    } else if ((m = BRACKETED.exec(head))) {
      lv = normalizeLevel(m[1]);
      cut = [m.index, m.index + m[0].length];
    } else if ((m = UPPER.exec(head))) {
      lv = normalizeLevel(m[1]);
      const i = m.index + m[0].lastIndexOf(m[1]);
      const end = i + m[1].length;
      cut = [i, rest[end] === ":" ? end + 1 : end];
      sure = i === 0;
    } else if ((m = COLONED.exec(head))) {
      lv = normalizeLevel(m[1]);
      const i = m.index + m[0].indexOf(m[1]);
      cut = [i, m.index + m[0].length];
      sure = i === 0;
    }
  }
  const thrown = PANICKED.test(rest) ? "fatal" : EXCEPTION.test(rest) || UNHANDLED.test(rest) ? "error" : undefined;
  if (thrown) {
    lv = worse(thrown, lv);
    sure = false;
  }
  if (cut) rest = rest.slice(0, cut[0]) + rest.slice(cut[1]);
  rest = rest.replace(/^[\s:|-]+/, "").trim();
  if (!rest) return null;
  return record(b, lv === undefined ? (base.level ?? "info") : sure ? lv : worse(lv, base.level), rest, at);
}

/** An object read as the format says, or as the keys it has when the format is `auto`. */
function route(o: Obj, format: LogFormat, base: Base = {}): ParsedLine[] {
  let f = format;
  if (f === "auto") {
    const data = obj(own(o, "data"));
    if ("PRIORITY" in o || "MESSAGE" in o || "__REALTIME_TIMESTAMP" in o) f = "journald";
    else if ((data && (o.type === "request" || o.type === "log" || o.type === "summary")) || "deploymentId" in o || "timestampInMs" in o || "responseStatusCode" in o || obj(own(o, "proxy"))) f = "vercel";
    else if (obj(own(o, "attributes"))) f = "railway";
  }
  return f === "vercel" ? vercel(o) : one(f === "journald" ? journald(o) : f === "railway" ? railway(o) : fromObject(o, base));
}

/**
 * Reads one line as the format says (`auto` decides per line) and returns what it holds: usually one record or request,
 * more for a JSON array of objects (a log drain's batch). Never throws; a line that says nothing gives `[]`. `seen`
 * carries the request ids of a drain from one call to the next: a request counts once per id while the same one is given.
 */
export function parseLogLines(line: string, format: LogFormat = "auto", seen?: Seen): ParsedLine[] {
  current = seen;
  try {
    if (typeof line !== "string") return [];
    const raw = line.slice(0, MAX_LINE);
    const t = raw.trim();
    if (!t) return [];
    const f: LogFormat = typeof format === "string" ? format : "auto";
    if (f === "text") return one(text(raw));
    if (f === "clf") return one(clf(t) ?? text(raw));
    const first = t.charCodeAt(0);
    if (first === 123) {
      const o = jsonObject(t);
      return o ? route(o, f) : one(text(raw));
    }
    if (first === 91 && f !== "pino" && /^\[\s*\{/.test(t)) {
      const a = jsonValue(t);
      if (Array.isArray(a) && a.length <= MAX_ITEMS && a.every((x) => obj(x))) return a.flatMap((x) => route(x as Obj, f));
    }
    return one((f === "auto" && CLF_START.test(t) ? clf(t) : null) ?? text(raw));
  } catch {
    return [];
  } finally {
    current = undefined;
  }
}

const one = (p: Out | undefined): ParsedLine[] => (Array.isArray(p) ? p : p ? [p] : []);

/** The first thing a line holds, or null. See {@link parseLogLines}. */
export function parseLogLine(line: string, format: LogFormat = "auto"): ParsedLine | null {
  return parseLogLines(line, format)[0] ?? null;
}
