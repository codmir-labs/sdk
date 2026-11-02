import type { StackFrame } from "./index";
import { isNode, nodeBuiltin } from "./runtime-context";

/**
 * CSL-5636: source lines around an in-app frame, Node only. At most 3 frames; 5 lines before and after the frame's
 * line; each line cut to 240 characters; a file over 1 MB is not read; each file is read once per process (the cache
 * holds the lines, or null for an unreadable file). Any error means no lines for that frame. Synchronous, because it
 * runs while the event is built and the file is one the process just ran.
 */

export const MAX_SOURCE_FRAMES = 3;
export const SOURCE_CONTEXT_LINES = 5;
export const MAX_SOURCE_LINE = 240;
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_CACHED_FILES = 50;

type Fs = { statSync(p: string): { size: number; isFile(): boolean }; readFileSync(p: string, enc: "utf8"): string };

const cache = new Map<string, string[] | null>();

/** For tests. */
export function clearSourceCache(): void {
  cache.clear();
}

function toPath(filename: string): string | null {
  if (filename.startsWith("file://")) {
    try {
      const url = nodeBuiltin()?.("node:url") as { fileURLToPath(u: string): string } | undefined;
      return url ? url.fileURLToPath(filename) : null;
    } catch {
      return null;
    }
  }
  // An absolute path only: `<anonymous>`, `node:internal/...` and `http://...` are not files.
  return /^(?:\/|[A-Za-z]:[\\/])/.test(filename) ? filename : null;
}

function linesOf(filename: string, fs: Fs): string[] | null {
  if (cache.has(filename)) return cache.get(filename) ?? null;
  let lines: string[] | null = null;
  try {
    const path = toPath(filename);
    const st = path ? fs.statSync(path) : null;
    if (path && st && st.isFile() && st.size <= MAX_SOURCE_FILE_BYTES) lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    lines = null;
  }
  if (cache.size >= MAX_CACHED_FILES) cache.delete(cache.keys().next().value as string);
  cache.set(filename, lines);
  return lines;
}

/** Adds `pre_context`, `context_line` and `post_context` to the first 3 in-app frames whose file can be read. Mutates and returns `frames`. */
export function addSourceContext(frames: StackFrame[]): StackFrame[] {
  if (!isNode()) return frames;
  let fs: Fs | undefined;
  try {
    fs = nodeBuiltin()?.("node:fs") as Fs | undefined;
  } catch {
    fs = undefined;
  }
  if (!fs) return frames;
  let done = 0;
  for (const frame of frames) {
    if (done >= MAX_SOURCE_FRAMES) break;
    if (frame.in_app !== true || !frame.filename || !frame.lineno) continue;
    done++;
    const lines = linesOf(frame.filename, fs);
    const at = frame.lineno - 1;
    if (!lines || at < 0 || at >= lines.length) continue;
    const cut = (l: string) => l.slice(0, MAX_SOURCE_LINE);
    frame.pre_context = lines.slice(Math.max(0, at - SOURCE_CONTEXT_LINES), at).map(cut);
    frame.context_line = cut(lines[at]!);
    frame.post_context = lines.slice(at + 1, at + 1 + SOURCE_CONTEXT_LINES).map(cut);
  }
  return frames;
}
