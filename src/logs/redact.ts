/**
 * Text cleaning and grouping keys for the log monitor. Everything here is pure, has no Node import, and is
 * bounded: a text is cut to {@link MAX_INPUT} characters before any pattern runs, so no input can make it slow.
 *
 * The rule the monitor builds on: nothing a log line says is kept or sent until it went through {@link redact}.
 */

/** Longest text any function here looks at. */
export const MAX_INPUT = 1000;
/** Longest group key. */
export const MAX_KEY = 200;
/** Longest redacted sample kept for a finding. */
export const MAX_SAMPLE = 300;
/** Longest path pattern. */
export const MAX_PATH = 90;

const HEX = "[0-9a-fA-F]";

// Secrets and identifiers that have a recognisable shape.
const COOKIE = /\b(set-cookie|cookie)\s*[:=]\s*[^\n]*/gi;
const QUERY = /\?(?!\[q\])(?:\[[a-z]+\]|[^\s"'<>)\]}])+/g;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g;
const BEARER = /(bearer|basic)\s+([A-Za-z0-9._~+/=-]{6,})/gi;
const PLACEHOLDER = "\\[(?:secret|token|jwt|email|ip|id|uuid|hex|num|cookie|redacted)\\]";
// `auth` but not `author` (`authorization` stays one), and `sig` only as a whole part: `signal` and `design` are no secrets.
// The name may be quoted, as in a JSON pair.
const SECRET_PAIR = new RegExp(
  `((?:token|secret|password|passwd|pwd|api[-_]?key|auth(?!or(?!i[sz]))|signature|session|credential)[A-Za-z0-9_-]{0,40}|(?:^|[^A-Za-z0-9])sig(?:[_-][A-Za-z0-9_-]{0,40})?)(["']?)\\s*[=:]\\s*(?!(?:bearer|basic)\\b|${PLACEHOLDER})("[^"]*"|'[^']*'|[^\\s,;&)}\\]]+)`,
  "gi",
);
// Each prefix has its own form, so that no ordinary word is one: `skipped_records` and `npm-mirror-service` are words.
const PREFIXED =
  /\b(?:(?:[sp]k|rk|whsec|gh[pousr]|github_pat|glpat)[-_][A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|A[KS]IA[A-Z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29[._-][A-Za-z0-9_-]{8,})/g;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// The character before is captured instead of looked behind for: a lookbehind stops older browsers from parsing the file.
const IPV4 = /(^|[^\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g;
const COLON_RUN = /[0-9a-fA-F]*(?::[0-9a-fA-F]*){2,}/g;
const COLON_ID = new RegExp(`\\b${HEX}{1,12}(?::${HEX}{1,12}){3,}\\b`, "g");
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OPAQUE_ID = /\b(?:dpl|prj|team|req|usr|org|cus|sub|evt|pi|cs|sess)[-_][A-Za-z0-9]{10,}\b/g;
const CARD = /\b\d{4}(?:[ -]\d{4}){3}\b|\b\d{13,19}\b/g;
const HEX_LONG = /\b[0-9a-fA-F]{21,}\b/g;
const LONG_RUN = /[A-Za-z0-9+_=-]{25,}/g;
const PATH_ID = /\/(?:\d{3,}|c[a-z0-9]{23,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/\s"'?#)\]}]|$)/gi;

const mixedCase = (s: string): boolean => /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);

/** A whole address: one `::` and at most 7 groups, or exactly 8 groups, of up to 4 hex digits each. `12:30:45` is not one. */
function isIpv6(t: string): boolean {
  if (t.includes(":::") || !/^[0-9a-fA-F:]+$/.test(t)) return false;
  const groups = t.split(":");
  const filled = groups.filter(Boolean);
  if (filled.length === 0 || groups.some((g) => g.length > 4)) return false;
  const doubles = t.split("::").length - 1;
  return (doubles === 1 && filled.length <= 7) || (doubles === 0 && groups.length === 8 && filled.length === 8);
}

/** The address inside a run of hex digits and colons, if any; words glued on either side (`pid:2001:db8::1`) stay. */
function ipv6(run: string): string {
  let out = run;
  // What is left around a masked address may be one itself (`a::b:::c`), so go on until nothing changes.
  for (let i = 0; i < 4 && out.length <= 160; i++) {
    const next = ipv6Once(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function ipv6Once(run: string): string {
  const edge = (i: number): boolean => i === 0 || i === run.length || run[i] === ":" || run[i - 1] === ":";
  for (let s = 0; s < run.length; s++) {
    if (!edge(s)) continue;
    for (let e = run.length; e > s + 1; e--) {
      if (edge(e) && isIpv6(run.slice(s, e))) return `${run.slice(0, s)}[ip]${run.slice(e)}`;
    }
  }
  return run;
}

/** Extra patterns an app adds: each match becomes `[redacted]`. */
export type ExtraPattern = RegExp;

/** The global-flag copy of each extra pattern, so `lastIndex` never carries over. */
export function compileExtra(patterns: readonly ExtraPattern[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    try {
      if (p instanceof RegExp) out.push(new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`));
    } catch {
      // an unusable pattern is skipped; the built-in ones still apply
    }
  }
  return out;
}

/**
 * A text made safe to keep or send: emails, IPv4 and IPv6 addresses, bearer tokens, JWTs, prefixed and long secrets,
 * `token=...` pairs, cookies, query strings and ids in paths are replaced by a bracketed word. What it cannot judge it
 * keeps. Stable: `redact(redact(x)) === redact(x)`.
 */
export function redact(text: unknown, extra?: readonly RegExp[]): string {
  let s = typeof text === "string" ? text : text === undefined || text === null ? "" : safeString(text);
  if (s.length > MAX_INPUT) s = s.slice(0, MAX_INPUT);
  // A replacement can make the next pattern match (`1.2.3.4cookie=x` has no word boundary until the address is
  // gone), so run until the text stops changing: that is what makes the result stable. Most texts take one pass.
  for (let i = 0; i < 4; i++) {
    const next = pass(s, extra);
    if (next === s) break;
    s = next;
  }
  return s;
}

function pass(text: string, extra?: readonly RegExp[]): string {
  let s = text;
  if (extra) for (const re of extra) s = s.replace(re, "[redacted]");
  if (s.includes("ookie")) s = s.replace(COOKIE, (_m, k: string) => `${k.toLowerCase()}=[cookie]`);
  if (s.includes("eyJ")) s = s.replace(JWT, "[jwt]");
  if (/bearer|basic/i.test(s)) s = s.replace(BEARER, (m, k: string, t: string) => (/^bearer$/i.test(k) || /[\d=+/]/.test(t) ? `${k} [token]` : m));
  if (/[=:]/.test(s)) s = s.replace(SECRET_PAIR, (_m, k: string, q: string) => `${k}${q}=[secret]`);
  s = s.replace(PREFIXED, "[token]");
  // After the keyword patterns: a query such as `?,Bearer abc` would otherwise swallow the word that marks the token.
  if (s.includes("?")) s = s.replace(QUERY, "?[q]");
  if (s.includes("@")) s = s.replace(EMAIL, "[email]");
  if (s.includes(".")) s = s.replace(IPV4, "$1[ip]");
  if (s.includes(":")) {
    s = s.replace(COLON_RUN, ipv6);
    s = s.replace(COLON_ID, "[id]");
  }
  if (s.includes("-")) s = s.replace(UUID, "[uuid]");
  s = s.replace(OPAQUE_ID, "[id]");
  if (/\d{4}/.test(s)) s = s.replace(CARD, "[num]");
  s = s.replace(HEX_LONG, "[hex]");
  s = s.replace(LONG_RUN, (m) => (mixedCase(m) || m.length >= 40 ? "[secret]" : m));
  if (s.includes("/")) s = s.replace(PATH_ID, "/:id");
  return s;
}

/** Longest name (a release, a service) that is kept. */
const MAX_NAME = 64;
const W = "[A-Za-z0-9]{1,20}";
// Not 13 digits in a row: that is a card number or an id, not a commit.
const COMMIT = "(?!\\d{13})[0-9a-fA-F]{7,40}";
const TAIL_WORD = `(?:${W}|[0-9a-fA-F]{21,40})`;
const VER = `(?:v?\\d{1,9}\\.\\d{1,9}(?:\\.\\d{1,9})?|v\\d{1,9}(?:\\.\\d{1,9}){3})(?:[-+]${TAIL_WORD}(?:[.-]${TAIL_WORD}){0,5})?`;
const NPM = "[a-z0-9][a-z0-9._-]{0,29}";
const LOWER = "[a-z][a-z0-9]{0,19}";
// The whole value, one shape or another. Nothing here holds an `@` outside `name@`, a colon or a `?`.
const NAME_SHAPE = new RegExp(
  `^(?:${COMMIT}|(?:dpl|prj)_(?![A-Za-z0-9]*\\d{13})[A-Za-z0-9]{6,60}|${HEX}{8}(?:-${HEX}{4}){3}-${HEX}{12}|${VER}|(?:@[a-z0-9][a-z0-9._-]{0,19}/)?${NPM}@(?:${VER}|${COMMIT})|(?:${W}[-_./]){1,4}${COMMIT}|20\\d{6}(?:[-.T_]?(?:\\d{4}|\\d{6}))?|1[6-9]\\d{8}(?:\\d{3})?|${LOWER}(?:[-_./](?:${LOWER}|\\d{1,4})){0,7})$`,
);
const FOUR_PART = /^v\d+\.\d+\.\d+\.\d+/;
const MASKED = new RegExp(`${PLACEHOLDER}|\\[q\\]`);

/** The secret patterns a shape can hold (it has no space, colon, equals sign or `?`: a cookie, a pair, a bearer token and a query are none of its business). */
const secretShaped = (s: string): boolean => s.search(JWT) >= 0 || s.search(PREFIXED) >= 0;

function nameOnce(v: unknown, extra?: readonly RegExp[]): string {
  const s = typeof v === "string" ? v.trim().slice(0, MAX_INPUT) : "";
  if (!s) return "";
  if (extra?.some((re) => s.search(re) >= 0)) return "";
  // `v1.2.3.4` is a version, not an address; what follows it is looked at as any other text.
  if (s.length <= MAX_NAME && NAME_SHAPE.test(s) && !secretShaped(s) && s.replace(FOUR_PART, "v").search(IPV4) < 0) return s;
  const r = redact(s, extra);
  return MASKED.test(r) ? "" : r.slice(0, MAX_NAME).trim();
}

/**
 * A release or a service as it may be kept and sent, or "" when it is none or cannot be told apart once masked. The
 * shapes a developer gives a name (a commit, `web@1.4.0`, `main-<commit>`, a version, a date stamp, plain words) stay as
 * they are, though {@link redact} would take them for secrets; whatever else it masks makes the name "". An app's own
 * patterns win. At most 64 characters, stable: `nameOf(nameOf(x)) === nameOf(x)`.
 */
export function nameOf(v: unknown, extra?: readonly RegExp[]): string {
  const a = nameOnce(v, extra);
  return a && nameOnce(a, extra) === a ? a : "";
}

/** Longest text that is parsed as JSON; a longer one is taken as it is. */
const MAX_PARSE = 16_384;

const words = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The message of a structured record (`msg`, `message` or `event`, then its error's), or "" when it has none. */
export function objectText(o: unknown): string {
  if (typeof o !== "object" || o === null) return "";
  const r = o as Record<string, unknown>;
  const main = words(r.msg) || words(r.message) || words(r.event);
  const e = r.err ?? r.error;
  const cause = words(e) || words((e as { message?: unknown } | null | undefined)?.message);
  return main && cause && cause !== main ? `${main}: ${cause}` : main || cause;
}

/** The text of a log line: a string as it is, a JSON line or an object by its message, an Error by its stack. */
export function lineText(message: unknown): string {
  if (typeof message === "string") {
    if (message.length > MAX_PARSE || !/^\s*\{/.test(message)) return message;
    try {
      return objectText(JSON.parse(message)) || message;
    } catch {
      return message;
    }
  }
  if (message instanceof Error) return message.stack || `${message.name}: ${message.message}`;
  return objectText(message) || safeString(message);
}

function safeString(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    return typeof v === "object" ? JSON.stringify(v) ?? "" : String(v);
  } catch {
    return "";
  }
}

/** The user agent as a family, never the string. */
export type UaFamily = "browser" | "bot" | "node" | "curl" | "other";

export function uaFamily(ua: unknown): UaFamily {
  const s = typeof ua === "string" ? ua.slice(0, 300) : "";
  if (/^curl\b/i.test(s)) return "curl";
  if (/bot|crawl|spider|slurp|scan|headless|facebookexternalhit|semrush|ahrefs|python-requests|go-http-client|scrapy|zgrab|masscan|nuclei/i.test(s)) return "bot";
  if (/^node\b|node-fetch|undici|axios|\bgot\b/i.test(s)) return "node";
  if (/mozilla\/|chrome\/|safari\/|firefox\/|edg\//i.test(s)) return "browser";
  return "other";
}

const SEG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEG_HEX = /^[0-9a-f]{16,}$/i;
const SEG_CUID = /^c[a-z0-9]{23,31}$/;
const SEG_PREFIXED = /^[a-z]{2,6}[-_][A-Za-z0-9]{12,}$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/; // eslint-disable-line no-control-regex

/** One path segment folded: numbers to `:n`, uuids to `:uuid`, id-like and hash-like names to `:id` and `:token`; what `redact` masks stays masked. */
function foldSegment(seg: string): string {
  if (seg === "") return seg;
  let raw = seg;
  try {
    raw = decodeURIComponent(seg);
  } catch {
    // keep the segment as it is
  }
  if (raw.includes("@")) return ":token";
  raw = raw.replace(/[?#][^]*$/, "") || ":token"; // an encoded query is a query
  if (/^\d+$/.test(raw)) return ":n";
  if (SEG_UUID.test(raw)) return ":uuid";
  if ((SEG_CUID.test(raw) || SEG_PREFIXED.test(raw)) && /\d/.test(raw)) return ":id";
  if (SEG_HEX.test(raw)) return ":token";
  if (raw.length >= 24 && /^[A-Za-z0-9_+=.-]+$/.test(raw) && (/\d/.test(raw) || mixedCase(raw))) return ":token";
  if (raw.length > 48) return ":token";
  // Before the numbers are folded: `2001:db8::7` with its first number gone is no address to any later check.
  const out = redact(`/${raw}`).slice(1).replace(/\b[0-9a-f]{8,}\b/gi, ":token").replace(/\d{4,}/g, ":n");
  // The decoding above can make an escape sequence live, and what is left can read as a secret (`:token-:n`).
  return CONTROL.test(out) || redact(out) !== out ? ":token" : out;
}

/** A path as a pattern: no origin, query or fragment, ids folded, `_next/static` one entry, at most 90 characters. */
export function pathPattern(path: unknown): string {
  let s = typeof path === "string" ? path.slice(0, 500) : "";
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(s);
  if (origin) s = s.slice(origin[0].length);
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (!s.startsWith("/")) s = `/${s}`;
  const segs = s.split("/").slice(1);
  while (segs.length > 1 && segs[segs.length - 1] === "") segs.pop();
  if (segs[0] === "_next" && segs[1] === "static") return "/_next/static/*";
  // Once more for the whole path: a name in one segment can make the next one a secret (`/token:/…`).
  let out = redact(`/${segs.map(foldSegment).join("/")}`);
  // Cut between two segments: half a mask (`token=[sec`) would read as a secret the next time.
  if (out.length > MAX_PATH) out = `${out.slice(0, Math.max(0, out.lastIndexOf("/", MAX_PATH - 4)))}/...`;
  // A key must be what `redact` leaves as it is, or the group is dropped at a restart; `/token:` in front of `|500` is not.
  const key = `GET|${out}|500`;
  return redact(key) === key ? out : "/:token";
}

const DATE_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const DATE_ONLY = /\b\d{4}-\d{2}-\d{2}\b/g;
const CLOCK = /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|us|µs|ns|s|sec|secs|seconds|m|min|mins|minutes|h)\b/gi;
const HASHY = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/gi;
const QUOTED = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g;

/** The file name of a stack frame without its build hash: `at f (/srv/.next/chunks/page-3fa9c1d2.js:1:2)` gives `page-[hash].js`. */
function frameFile(line: string, extra?: readonly RegExp[]): string {
  const m = /\(?((?:file:\/\/)?[^\s()]+?)(?::\d+){0,2}\)?\s*$/.exec(line.trim());
  const base = (m?.[1] ?? "").split("/").filter(Boolean).pop() ?? "";
  if (!base) return "";
  return redact(base, extra)
    .replace(/[-_.]{1,2}(?=[a-z0-9]*\d)[a-z0-9]{8,}(?=\.|$)/gi, "-[hash]")
    .replace(/^\d+(?=\.)/, "[n]")
    .slice(0, 60);
}

/**
 * The grouping text of a log message: the first line that is not a stack frame, redacted, with dates, times,
 * durations, hashes, numbers and quoted values folded, plus the file of the first stack frame. At most 160 characters.
 * A JSON line is read by its message: its quoted values would fold every line into one.
 */
export function messageKey(text: unknown, extra?: readonly RegExp[]): string {
  const raw = lineText(text).slice(0, MAX_INPUT);
  const lines = raw.split(/\r?\n/);
  const first = lines.find((l) => l.trim() && !/^\s*at\s/.test(l)) ?? "";
  const frame = lines.find((l) => /^\s*at\s/.test(l));
  let k = redact(first.trim(), extra)
    .replace(QUOTED, "[v]")
    .replace(DATE_TIME, "[ts]")
    .replace(DATE_ONLY, "[date]")
    .replace(CLOCK, "[time]")
    .replace(DURATION, "[dur]")
    .replace(HASHY, "[hex]")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ");
  if (k.length > 160) k = `${k.slice(0, 157)}...`;
  const file = frame ? frameFile(frame, extra) : "";
  return file ? `${k} @ ${file}` : k;
}

/** A short stable id for a key: two 32-bit FNV-1a hashes, 8 hex characters. */
export function shortId(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b + c, 0x85ebca6b) ^ (b >>> 13);
  }
  return ((a ^ b) >>> 0).toString(16).padStart(8, "0");
}

const SCANNER =
  /\.php\b|\/wp-|\/wordpress|\.env\b|\/\.git\b|vendor\/phpunit|xmlrpc|phpmyadmin|\/cgi-bin|\/\.aws|\/\.ssh|\/actuator|\/\.ds_store|\/etc\/passwd|\.aspx?\b|\.jsp\b|\.sql\b|\.bak\b|\/boaform|\/solr\/|\/jenkins|\/\.vscode|\/\.svn|\/eval-stdin/i;

/** The built-in list of probes: paths scanners ask for on every public server (wp-, .env, .git, .php and the like). */
export const isScannerPath = (path: unknown): boolean => SCANNER.test(typeof path === "string" ? path.slice(0, 500) : "");
