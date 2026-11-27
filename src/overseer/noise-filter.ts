import { parseStackTrace } from "./stack";

/**
 * The options that keep known noise from being stored: `ignoreErrors`, `denyUrls` and `allowUrls`. A string matches as a
 * substring, a RegExp when it tests true (its `lastIndex` is never carried over); an entry of another type, and an empty
 * string, which would match everything, are ignored.
 */
export interface NoiseFilterConfig {
  ignoreErrors?: Array<string | RegExp>;
  denyUrls?: Array<string | RegExp>;
  allowUrls?: Array<string | RegExp>;
  /** `false` turns off the built-in `ignoreErrors` entries. */
  defaultIgnoreErrors?: boolean;
}

/** What a filter reads of an event: its texts, and the place it came from, looked up only when a URL option is set. */
export interface NoiseCandidate {
  /** The texts `ignoreErrors` is matched against: `<type>: <message>` and the bare message of an error, the text of a message. */
  texts: string[];
  /** The bare message, for the built-in entries. */
  message: string;
  /** The stack the frames are read from, when the event has one. */
  stack?: string;
  /** The event's own file name, used when there is no frame. */
  file?: string;
}

export type NoiseOption = "ignoreErrors" | "defaultIgnoreErrors" | "denyUrls" | "allowUrls";

type Pattern = string | RegExp;

const patterns = (list: unknown): Pattern[] =>
  Array.isArray(list) ? list.filter((p): p is Pattern => (typeof p === "string" && p !== "") || p instanceof RegExp) : [];

function matches(list: readonly Pattern[], text: string): boolean {
  for (const p of list) {
    if (typeof p === "string") {
      if (text.includes(p)) return true;
      continue;
    }
    // A global or sticky RegExp remembers where it stopped: start from the top each time.
    p.lastIndex = 0;
    if (p.test(text)) return true;
  }
  return false;
}

/** The browser's cross-origin `Script error.`, whole, with or without the period; a `ResizeObserver loop` message. */
function isDefaultNoise(message: string): boolean {
  const m = message.trim();
  return /^Script error\.?$/i.test(m) || m.startsWith("ResizeObserver loop");
}

/** The file of the innermost frame (the first the engine printed that names a file), else the event's own file name. */
function urlOf(candidate: NoiseCandidate): string | undefined {
  const frame = parseStackTrace(candidate.stack).find((f) => f.filename);
  return frame?.filename ?? (candidate.file ? candidate.file : undefined);
}

export class NoiseFilter {
  private readonly ignore: Pattern[];
  private readonly deny: Pattern[];
  private readonly allow: Pattern[];
  private readonly defaults: boolean;

  constructor(config: NoiseFilterConfig) {
    this.ignore = patterns(config.ignoreErrors);
    this.deny = patterns(config.denyUrls);
    this.allow = patterns(config.allowUrls);
    this.defaults = config.defaultIgnoreErrors !== false;
  }

  /** The option that drops the event, or null when it is kept. Never throws: an event that cannot be read is kept. */
  check(candidate: NoiseCandidate): NoiseOption | null {
    try {
      if (this.defaults && isDefaultNoise(candidate.message)) return "defaultIgnoreErrors";
      if (this.ignore.length && candidate.texts.some((text) => matches(this.ignore, text))) return "ignoreErrors";
      if (this.deny.length || this.allow.length) {
        const url = urlOf(candidate);
        if (url !== undefined) {
          if (this.deny.length && matches(this.deny, url)) return "denyUrls";
          if (this.allow.length && !matches(this.allow, url)) return "allowUrls";
        }
      }
    } catch {
      // a filter that fails lets the event through
    }
    return null;
  }
}
