import type { StackFrame } from "./index";

/**
 * Stack string -> frames, for every engine's format. Top frame first, as the engine prints them.
 *
 * - V8 (Node, Chrome, Edge): `at fn (file:l:c)`, `at file:l:c`, `at async fn (file:l:c)`, `at new Foo (file:l:c)`,
 *   `at fn (eval at g (file:l:c), <anonymous>:l:c)`, `at fn (native)`, `at fn (<anonymous>)`.
 * - Firefox and Safari: `fn@file:l:c`, `@file:l:c`, `fn@[native code]`.
 * The header (`Error: message`, which may span lines) is never a frame: V8 lines are recognised by their `at `, the
 * other engines have no header, so every `@` line that ends in a location is a frame. A frame that cannot be read
 * is kept with what it has, never thrown on. A frame whose location is not `file:line` has a function and no filename.
 *
 * `in_app` is false for: a frame with no line; `node:` and `<...>` files; `node_modules`; the SDK's own files; a browser
 * extension (`chrome-extension:`, `moz-extension:`, `safari-extension:`, `safari-web-extension:`) or Deno's `ext:` file;
 * and, in a page (a `location` with an http(s) origin), an http(s) file on an origin that is not the page's own, not the
 * origin `init()` was called from and not in `inAppOrigins`. Outside a page (Node, React Native, a worker with no
 * http(s) location) only the first rules apply.
 */

const SDK_PATH = /[\\/]@codmir[\\/]sdk[\\/]/;

const URL_SHAPED = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|blob:|webpack-internal:)/i;

/**
 * A frame's file as it is stored: a URL-shaped one (a scheme and `//`, `blob:`, `webpack-internal:`) loses its query and
 * fragment, which can hold a token or a cache-buster and would split one bug into one issue per value. A plain path,
 * `node:` internal or `<anonymous>` is returned as it is, a `#` or `?` included.
 */
export function frameFilename(filename: string): string {
  return URL_SHAPED.test(filename) ? (filename.split(/[?#]/)[0] ?? "") : filename;
}

const NEVER_APP = /^(?:(?:chrome|moz|safari|safari-web)-extension:|ext:)/i;

/** The origin of an http(s) URL, else undefined (a path, `node:`, `blob:`, `webpack-internal:`, an extension). */
function httpOrigin(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The page's own origin when this runs in a page or a worker with an http(s) location, else undefined. */
function pageOrigin(): string | undefined {
  try {
    const loc = (globalThis as { location?: { origin?: unknown; protocol?: unknown } }).location;
    return loc && (loc.protocol === "http:" || loc.protocol === "https:") && typeof loc.origin === "string" ? loc.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The origin of the code that called `init()`, read from the stack of that call: the first http(s) frame in a file other
 * than the SDK's own (the top frame's), else the top frame's origin when everything is one file (an app bundled with the
 * SDK). Undefined outside a page. A bundle served from a CDN keeps its frames in-app through this.
 */
export function callerOrigin(stack: string | undefined): string | undefined {
  if (!pageOrigin()) return undefined;
  const files = parseStackTrace(stack).map((f) => f.filename).filter((f): f is string => !!f);
  const own = files[0];
  const caller = files.find((f) => f !== own && httpOrigin(f));
  return httpOrigin(caller ?? own ?? "");
}

/** Origins as `new URL(...).origin` writes them; an entry that is not an http(s) URL is ignored. */
export function normalizeOrigins(origins: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const o of origins ?? []) {
    const origin = typeof o === "string" ? httpOrigin(o.trim()) : undefined;
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

function isInApp(filename: string | undefined, lineno: number | undefined, appOrigins: readonly string[] | undefined): boolean {
  if (!filename || lineno === undefined) return false;
  if (filename.startsWith("node:") || filename.startsWith("<") || filename === "native" || filename === "[native code]") return false;
  if (NEVER_APP.test(filename)) return false;
  if (filename.includes("node_modules")) return false;
  if (SDK_PATH.test(filename)) return false;
  const page = pageOrigin();
  const origin = page ? httpOrigin(filename) : undefined;
  return !origin || origin === page || !!appOrigins?.includes(origin);
}

function frameOf(fn: string | undefined, location: string, appOrigins: readonly string[] | undefined): StackFrame {
  const m = location.match(/^(.*?):(\d+):(\d+)$/) ?? location.match(/^(.*?):(\d+)$/);
  const frame: StackFrame = {};
  if (fn) frame.function = fn;
  if (m) {
    frame.filename = frameFilename(m[1]!);
    frame.lineno = parseInt(m[2]!, 10);
    if (m[3] !== undefined) frame.colno = parseInt(m[3], 10);
  }
  // A location that is not `file:line[:col]` (`index 0`, `native`, `<anonymous>`, `[native code]`, a wasm position) names
  // no file: the frame keeps its function and is never app code.
  frame.in_app = isInApp(frame.filename, frame.lineno, appOrigins);
  return frame;
}

function parseV8Line(line: string, appOrigins: readonly string[] | undefined): StackFrame | null {
  let rest = line.replace(/^\s*at\s+/, "").trim();
  if (!rest) return null;
  // `async` marks a frame resumed after an await; the function name (or location) follows.
  rest = rest.replace(/^async\s+/, "");
  const open = rest.indexOf(" (");
  if (open > 0 && rest.endsWith(")")) {
    const fn = rest.slice(0, open);
    let location = rest.slice(open + 2, -1);
    // `eval at g (file:1:1), <anonymous>:1:1`: the position inside the evaluated code is the last part.
    if (location.startsWith("eval at ")) location = location.slice(location.lastIndexOf(", ") + 2);
    return frameOf(fn, location, appOrigins);
  }
  return frameOf(undefined, rest, appOrigins);
}

function parseGeckoLine(line: string, appOrigins: readonly string[] | undefined): StackFrame | null {
  const at = line.indexOf("@");
  if (at < 0) return null;
  const location = line.slice(at + 1).trim();
  if (!/:\d+(:\d+)?$/.test(location) && location !== "[native code]") return null;
  const fn = line.slice(0, at).trim().replace(/^async\*/, "");
  return frameOf(fn || undefined, location, appOrigins);
}

/** `appOrigins`: extra origins whose http(s) frames are app code in a page (the init caller's, `inAppOrigins`). */
export function parseStackTrace(stack?: string, appOrigins?: readonly string[]): StackFrame[] {
  if (!stack) return [];
  const lines = stack.split("\n");
  const v8 = lines.some((l) => /^\s+at\s/.test(l));
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const frame = v8 ? (/^\s+at\s/.test(line) ? parseV8Line(line, appOrigins) : null) : parseGeckoLine(line, appOrigins);
    if (frame && (frame.function || frame.filename)) frames.push(frame);
  }
  return frames;
}
