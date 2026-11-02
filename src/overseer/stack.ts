import type { StackFrame } from "./index";

/**
 * CSL-5636: stack string -> frames, for every engine's format. Top frame first, as the engine prints them.
 *
 * - V8 (Node, Chrome, Edge): `at fn (file:l:c)`, `at file:l:c`, `at async fn (file:l:c)`, `at new Foo (file:l:c)`,
 *   `at fn (eval at g (file:l:c), <anonymous>:l:c)`, `at fn (native)`, `at fn (<anonymous>)`.
 * - Firefox and Safari: `fn@file:l:c`, `@file:l:c`, `fn@[native code]`.
 * The header (`Error: message`, which may span lines) is never a frame: V8 lines are recognised by their `at `, the
 * other engines have no header, so every `@` line that ends in a location is a frame. A frame that cannot be read
 * is kept with what it has, never thrown on.
 */

const SDK_PATH = /[\\/]@codmir[\\/]sdk[\\/]/;

function isInApp(filename: string | undefined): boolean {
  if (!filename) return false;
  if (filename.startsWith("node:") || filename.startsWith("<") || filename === "native" || filename === "[native code]") return false;
  if (filename.includes("node_modules")) return false;
  return !SDK_PATH.test(filename);
}

function frameOf(fn: string | undefined, location: string): StackFrame {
  const m = location.match(/^(.*?):(\d+):(\d+)$/) ?? location.match(/^(.*?):(\d+)$/);
  const frame: StackFrame = {};
  if (fn) frame.function = fn;
  if (m) {
    frame.filename = m[1];
    frame.lineno = parseInt(m[2]!, 10);
    if (m[3] !== undefined) frame.colno = parseInt(m[3], 10);
  } else if (location) {
    frame.filename = location; // `native`, `<anonymous>`, `[native code]`
  }
  frame.in_app = isInApp(frame.filename);
  return frame;
}

function parseV8Line(line: string): StackFrame | null {
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
    return frameOf(fn, location);
  }
  return frameOf(undefined, rest);
}

function parseGeckoLine(line: string): StackFrame | null {
  const at = line.indexOf("@");
  if (at < 0) return null;
  const location = line.slice(at + 1).trim();
  if (!/:\d+(:\d+)?$/.test(location) && location !== "[native code]") return null;
  const fn = line.slice(0, at).trim().replace(/^async\*/, "");
  return frameOf(fn || undefined, location);
}

export function parseStackTrace(stack?: string): StackFrame[] {
  if (!stack) return [];
  const lines = stack.split("\n");
  const v8 = lines.some((l) => /^\s+at\s/.test(l));
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const frame = v8 ? (/^\s+at\s/.test(line) ? parseV8Line(line) : null) : parseGeckoLine(line);
    if (frame && (frame.function || frame.filename)) frames.push(frame);
  }
  return frames;
}
