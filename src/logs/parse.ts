/**
 * Reads one line of a log an app already has (JSON lines, a hosting platform's output, the system journal, pino, a web
 * server's access log, plain text) as what the monitor takes in. Pure: no Node import, never throws, and bounded: a line
 * is cut to 64 KB first, JSON nested deeper than 20 levels is text, and every pattern is linear (the longest runs of a
 * pattern are bounded or made of one character class). Nothing is redacted here: the monitor does that before keeping anything.
 */
import { normalizeLevel } from "./level";
import { redact } from "./redact";
import type { LogFormat, LogLevel, LogRecord, ParsedLine, RequestRecord } from "./types";

export const MAX_LINE = 65536;
const MAX_DEPTH = 20;
const MAX_TEXT = 2000;
const MAX_ITEMS = 1000;

type Obj = Record<string, unknown>;
type Pick<T> = (v: unknown) => T | undefined;
interface Base {
  level?: LogLevel;
  service?: string;
  time?: number;
  /** `service` and `time` win over the object's own (the journal's are the truth). */
  over?: boolean;
}

const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str: Pick<string> = (v) => (typeof v === "string" && v.trim() ? v : undefined);
const name: Pick<string> = (v) => (typeof v === "string" && v.trim() ? v.slice(0, 64) : undefined);
const P = (s: string): string[][] => s.split(" ").map((p) => p.split("."));
const find = <T>(o: Obj, paths: string[][], as: Pick<T>): T | undefined => {
  for (const path of paths) {
    let v: unknown = o;
    for (const k of path) v = obj(v) ? own(v as Obj, k) : undefined;
    const r = as(v);
    if (r !== undefined) return r;
  }
  return undefined;
};
const done = <T extends object>(o: T): T => {
  for (const k of Object.keys(o)) if ((o as Obj)[k] === undefined) delete (o as Obj)[k];
  return o;
};

const LEVEL = P("level severity lvl log.level");
const MESSAGE = P("message msg event");
const TIME = P("time timestamp ts @timestamp");
const SERVICE = P("service name logger");
const RELEASE = P("release version dd.version");
const METHOD = P("method req.method httpRequest.requestMethod request.method");
const URL_ = P("path url req.url httpRequest.requestUrl request.url");
const STATUS = P("status statusCode res.statusCode httpRequest.status response.status");
const DURATION = P("durationMs duration responseTime elapsed");
const AGENT = P("userAgent user_agent httpRequest.userAgent req.headers.user-agent request.headers.user-agent");

/** A level word, a pino number (10 trace to 60 fatal) or a digit string of one. */
const level: Pick<LogLevel> = (v) => {
  if (typeof v === "string") {
    if (!/^\d{1,3}$/.test(v)) return v ? normalizeLevel(v) : undefined;
    v = +v;
  }
  return typeof v === "number" && v >= 10 ? (v >= 60 ? "fatal" : v >= 50 ? "error" : v >= 40 ? "warning" : v >= 30 ? "info" : "debug") : undefined;
};

/** Epoch milliseconds from a time in any of the common shapes: seconds, milliseconds, microseconds or nanoseconds by size, or a date string. */
const time: Pick<number> = (v) => {
  let n = NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    if (!/^\d{1,19}(?:\.\d{1,9})?$/.test(v)) {
      n = Date.parse(v);
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

/** The path of a URL or path: no origin (and so no user and password), no query, no fragment, and no address or secret in a segment. */
const path: Pick<string> = (v) => {
  let s = typeof v === "string" ? v.slice(0, 600).trim() : "";
  if (!s) return undefined;
  const origin = /^[a-z][a-z0-9+.-]{0,20}:\/\/[^/?#]*/i.exec(s);
  if (origin) s = s.slice(origin[0].length);
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  return redact(s.slice(0, 500)) || "/";
};

const isBad = (l: LogLevel): boolean => l === "warning" || l === "error" || l === "fatal";

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

/** A JSON object of any of the common shapes: a record, or a request when it carries a method, a path and a status. */
function fromObject(o: Obj, base: Base = {}): ParsedLine | null {
  const e = obj(own(o, "err")) ?? obj(own(o, "error"));
  const lv = find(o, LEVEL, level) ?? base.level ?? (e || str(own(o, "error")) ? "error" : "info");
  const t = (base.over ? base.time : undefined) ?? find(o, TIME, time) ?? base.time;
  const service = (base.over ? base.service : undefined) ?? find(o, SERVICE, name) ?? base.service;
  const release = find(o, RELEASE, name);
  const m = find(o, METHOD, method);
  const p = find(o, URL_, path);
  const code = find(o, STATUS, status);
  if (m && p && code && !(code < 400 && (lv === "error" || lv === "fatal"))) {
    return { request: done<RequestRecord>({ method: m, path: p, status: code, durationMs: find(o, DURATION, ms), userAgent: find(o, AGENT, agent), time: t, release, service }) };
  }
  let text = find(o, MESSAGE, str);
  const em = e ? str(own(e, "message")) : undefined;
  const et = e ? (str(own(e, "type")) ?? str(own(e, "name")) ?? str(own(e, "code"))) : undefined;
  const why = e ? (em ? (et ? `${et}: ${em}` : em) : et) : (str(own(o, "error")) ?? str(own(o, "err")));
  if (why && !text?.includes(em ?? why)) text = text ? `${text}: ${why}` : why;
  if (!text) return null;
  return { record: done<LogRecord>({ level: lv, message: text.slice(0, MAX_TEXT), time: t, path: p, release, service }) };
}

const PRIORITY: LogLevel[] = ["fatal", "fatal", "fatal", "error", "warning", "info", "info", "debug"];

/** `journalctl -o json`: PRIORITY 0 to 7, MESSAGE as a string, an array of bytes or null. */
function journald(o: Obj): ParsedLine | null {
  if (!("MESSAGE" in o) && !("PRIORITY" in o)) return fromObject(o);
  const raw = own(o, "MESSAGE");
  let text: string | undefined;
  if (typeof raw === "string") text = raw;
  else if (Array.isArray(raw) && raw.length <= MAX_LINE && raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) text = new TextDecoder().decode(Uint8Array.from(raw as number[]));
  text = text?.slice(0, MAX_LINE).trim();
  if (!text) return null;
  const p = Number(own(o, "PRIORITY"));
  const lv = Number.isInteger(p) ? PRIORITY[p] : undefined;
  const unit = str(own(o, "_SYSTEMD_USER_UNIT")) ?? str(own(o, "_SYSTEMD_UNIT"));
  const service = (unit ? name(unit.replace(/\.service$/, "")) : undefined) ?? name(own(o, "SYSLOG_IDENTIFIER")) ?? name(own(o, "_COMM"));
  const at = time(own(o, "__REALTIME_TIMESTAMP"));
  const base: Base = { level: lv, service, time: at, over: true };
  const inner = jsonObject(text);
  const parsed = inner && fromObject(inner, base);
  if (parsed) return parsed;
  return { record: done<LogRecord>({ level: lv ?? "info", message: text.slice(0, MAX_TEXT), time: at, service }) };
}

/** Railway's JSON lines: `attributes` carries the fields of a structured log, `severity` is the stream's. */
function railway(o: Obj): ParsedLine | null {
  const a = obj(own(o, "attributes"));
  const merged: Obj = Object.create(null);
  for (const [src, skip] of [[a, ""], [o, "attributes"]] as const) {
    if (src) for (const k of Object.keys(src)) if (k !== skip) merged[k] = src[k];
  }
  if (a && level(own(a, "level"))) merged.level = own(a, "level");
  return fromObject(merged);
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
/** Vercel: the CLI's `{ type, data }` lines, a log drain's object and the older CLI's flat line. */
function vercel(o: Obj): ParsedLine | null {
  const type = own(o, "type");
  if (type === "summary" || own(o, "status") === "error") return null;
  const d = (type === "request" || type === "log") && obj(own(o, "data")) ? (obj(own(o, "data")) as Obj) : o;
  const proxy = obj(own(d, "proxy"));
  const at = find(d, V_TIME, time) ?? (proxy && time(own(proxy, "timestamp")));
  const lv = find(d, LEVEL, level) ?? "info";
  const text = find(d, V_MESSAGE, str)?.slice(0, MAX_TEXT);
  const m = find(d, V_METHOD, method) ?? (proxy && method(own(proxy, "method")));
  const p = find(d, V_PATH, path) ?? (proxy && path(own(proxy, "path")));
  const code = find(d, V_STATUS, status) ?? (proxy && status(own(proxy, "statusCode")));
  const env = find(d, V_ENV, name);
  const src = find(d, V_SOURCE, name);
  const service = [env, src].filter(Boolean).join(" ").slice(0, 64) || undefined;
  const release = find(d, V_RELEASE, name);
  const asRequest = (): ParsedLine | null =>
    m && p && code ? { request: done<RequestRecord>({ method: m, path: p, status: code, userAgent: find(d, V_AGENT, agent) ?? (proxy && agent(own(proxy, "userAgent"))), time: at, release, service }) } : null;
  const asRecord = (): ParsedLine | null => (text ? { record: done<LogRecord>({ level: lv, message: text, time: at, path: p, release, service }) } : null);
  if (type === "request") return asRequest();
  if (type === "log") return asRecord();
  const req = asRequest();
  if (req && text) return code && code >= 500 ? req : isBad(lv) ? asRecord() : req;
  return req ?? asRecord();
}

/** Apache and nginx Common and Combined Log Format. The client address, the user and the referer are never kept. */
const CLF = /^[^ ]+ [^ ]+ [^ ]+ \[([^\]]{20,30})\] "([A-Za-z]{3,10}) ([^" ]{1,2000})(?: [^"]{0,20})?" (\d{3}) (?:\d+|-)(?: "[^"]{0,2000}" "([^"]{0,500})")?/;
const CLF_TIME = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d\d)(\d\d)$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** `10/Oct/2000:13:55:36 -0700` as epoch milliseconds. */
function clfTime(v: string): number | undefined {
  const m = CLF_TIME.exec(v);
  const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || mon < 0) return undefined;
  const at = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) - (+m[7] * 60 + Math.sign(+m[7] || 1) * +m[8]) * 60_000;
  return Number.isFinite(at) ? at : undefined;
}
function clf(t: string): ParsedLine | null {
  const m = CLF.exec(t);
  const code = m && status(m[4]);
  if (!m || !code) return null;
  return { request: done<RequestRecord>({ method: m[2].toUpperCase(), path: path(m[3]) ?? "/", status: code, userAgent: m[5] && m[5] !== "-" ? m[5] : undefined, time: clfTime(m[1]) }) };
}

const WORDS = "TRACE|DEBUG|VERBOSE|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE|PANIC|ALERT|EMERGENCY|EMERG";
const BRACKETED = new RegExp(`[\\[(<]\\s*(${WORDS})\\s*[\\])>]`, "i");
const UPPER = new RegExp(`(?:^|[^A-Za-z0-9_])(${WORDS})(?![A-Za-z0-9_])`);
const COLONED = new RegExp(`(?:^|\\s)(${WORDS})\\s*:`, "i");
const KV_LEVEL = /(?:^|\s)level=["']?([A-Za-z]{3,9})/i;
const KV_MSG = /(?:^|\s)(?:msg|message)=(?:"((?:[^"\\]|\\.){0,1000})"|(\S{1,1000}))/;
const ANDROID = /^([VDIWEF])\/[\w.$-]{1,60}/;
const GLOG = /^([IWEF])\d{4} \d\d:\d\d:\d\d/;
const SHORT: Record<string, LogLevel> = { V: "debug", D: "debug", I: "info", W: "warning", E: "error", F: "fatal" };
const STAMP = /^\[?(?:(?:time|ts)=["']?)?(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?(Z|[+-]\d\d(?::?\d\d)?)?["']?\]?[\s:|-]*/;
const BRACKET_STAMP = /^\[([^\]]{4,40})\]\s*/;
const ANSI = /\x1b\[[0-9;?]{0,20}[ -/]?[@-~]/g; // eslint-disable-line no-control-regex
const STACK = /^(?:\s+at\s|\s*Caused by:|\s*\.\.\. \d+ (?:more|common)|\s+File ".{0,500}", line \d)/;
const PROMPT = /^(?:\S{1,60}\s)?\S{0,60}[$#%>]$/;

function stamp(m: RegExpExecArray): number | undefined {
  const z = m[8];
  const off = !z || z === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 60 + +(z.replace(":", "").slice(3, 5) || 0));
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] ?? "0").slice(0, 3).padEnd(3, "0")) - off * 60_000;
  return Number.isFinite(at) ? at : undefined;
}

/** Plain text: a leading time, a level word near the start, and a stack-trace line (which belongs to the line before it) is nothing. */
function text(raw: string): ParsedLine | null {
  const line = raw.replace(ANSI, "");
  if (STACK.test(line)) return null;
  let rest = line.trim();
  if (!rest || (rest.length <= 130 && PROMPT.test(rest))) return null;
  let at: number | undefined;
  const s = STAMP.exec(rest);
  if (s) {
    at = stamp(s);
    rest = rest.slice(s[0].length);
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
  const inner = jsonObject(rest);
  if (inner) return route(inner, "auto", at);
  const head = rest.slice(0, 60);
  let lv: LogLevel | undefined;
  let cut: [number, number] | undefined;
  const kv = KV_LEVEL.exec(head);
  if (kv) {
    lv = normalizeLevel(kv[1]);
    const mm = KV_MSG.exec(rest);
    rest = mm ? (mm[1] ?? mm[2]).replace(/\\(.)/g, "$1") : rest;
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
      cut = [i, i + m[1].length];
    } else if ((m = COLONED.exec(head))) {
      lv = normalizeLevel(m[1]);
      const i = m.index + m[0].indexOf(m[1]);
      cut = [i, m.index + m[0].length];
    }
  }
  if (cut) rest = rest.slice(0, cut[0]) + rest.slice(cut[1]);
  rest = rest.replace(/^[\s:|-]+/, "").trim();
  if (!rest) return null;
  return { record: done<LogRecord>({ level: lv ?? "info", message: rest.slice(0, MAX_TEXT), time: at }) };
}

const CLF_START = /^[^ ]+ [^ ]+ [^ ]+ \[\d{1,2}\/[A-Za-z]{3}\/\d{4}:/;

/** An object read as the format says, or as the keys it has when the format is `auto`. */
function route(o: Obj, format: LogFormat, at?: number): ParsedLine | null {
  let f = format;
  if (f === "auto") {
    const data = obj(own(o, "data"));
    if ("PRIORITY" in o || "MESSAGE" in o || "__REALTIME_TIMESTAMP" in o) f = "journald";
    else if ((data && (o.type === "request" || o.type === "log" || o.type === "summary")) || "deploymentId" in o || "timestampInMs" in o || "responseStatusCode" in o || obj(own(o, "proxy"))) f = "vercel";
    else if (obj(own(o, "attributes"))) f = "railway";
  }
  return f === "journald" ? journald(o) : f === "vercel" ? vercel(o) : f === "railway" ? railway(o) : fromObject(o, { time: at });
}

/**
 * Reads one line as the format says (`auto` decides per line) and returns what it holds: usually one record or request,
 * more for a JSON array of objects (a log drain's batch). Never throws; a line that says nothing gives `[]`.
 */
export function parseLogLines(line: string, format: LogFormat = "auto"): ParsedLine[] {
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
      return o ? one(route(o, f)) : one(text(raw));
    }
    if (first === 91 && f !== "pino" && /^\[\s*\{/.test(t)) {
      const a = jsonValue(t);
      if (Array.isArray(a) && a.length <= MAX_ITEMS && a.every((x) => obj(x))) return a.flatMap((x) => one(route(x as Obj, f)));
    }
    return one((f === "auto" && CLF_START.test(t) ? clf(t) : null) ?? text(raw));
  } catch {
    return [];
  }
}

const one = (p: ParsedLine | null | undefined): ParsedLine[] => (p ? [p] : []);

/** The first thing a line holds, or null. See {@link parseLogLines}. */
export function parseLogLine(line: string, format: LogFormat = "auto"): ParsedLine | null {
  return parseLogLines(line, format)[0] ?? null;
}
