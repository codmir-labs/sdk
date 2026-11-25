/**
 * What the log monitor keeps across a restart: building the state to save and reading back a state that may be broken,
 * old, hand-edited or hostile. Isomorphic, no Node import. Nothing a store returns is trusted: every field is checked,
 * every string is cut and redacted again, and a group that is not whole is dropped on its own.
 */
import type { Group } from "./monitor";
import { MAX_KEY, MAX_SAMPLE, isScannerPath, nameOf, redact, shortId } from "./redact";
import type { LogLevel, LogState, LogStateGroup, LogStateMark, MarkOptions } from "./types";

export const COUNT_BATCHES = 96;
export const FORGET_MS = 30 * 24 * 3_600_000;
export const MAX_RELEASES = 8;
export const MAX_MARKS = 500;

export interface Loaded {
  groups: Group[];
  marks: Array<[string, MarkOptions]>;
  /** The file's `cloud` part, unchecked: `Cloud.restore` reads it. */
  cloud: unknown;
}

/** Every number is a whole one up to this: a time up to the largest a Date takes, a count far below it. */
const MAX_N = 8.64e15;
const FAMILIES = ["browser", "bot", "node", "curl", "other"];
const NUMS = ["total", "backCount", "nonBot", "pathHits", "scannerHits", "durN", "durSum", "durMax", "sentBack", "firstMs", "lastMs", "sentAt", "sentTotal"];

function bad(): never {
  throw new Error();
}
const int = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_N ? (v as number) : bad());
const text = (v: unknown, n: number): string => (typeof v === "string" ? redact(v.slice(0, n)).slice(0, n) : bad());
/** A release or a service: a wrong type is a broken group, a name that is none any more ("") is left out alone. */
const name = (v: unknown): string => (typeof v === "string" ? nameOf(v) : bad());
/** A key or an id as the monitor makes it: short, and not changed by `redact`. */
const clean = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_KEY && redact(v) === v;

/**
 * What a group is, read from its key: `error|the folded message` is a message, `GET|/users/:n|500` a request. The monitor
 * makes every group this way, so a group that was saved and loaded is the one it was. Null for a key that is neither.
 */
export function seedOf(key: string, isNoise: (label: string) => boolean): Pick<Group, "kind" | "title" | "noise"> & Partial<Pick<Group, "method" | "path" | "status" | "level">> | null {
  const m = /^(debug|info|warning|error|fatal)\|([\s\S]*)$/.exec(key);
  if (m) return { kind: "message", level: m[1] as LogLevel, title: m[2], noise: isNoise(`${m[1].toUpperCase()} ${m[2]}`) };
  const r = /^([A-Z]{1,10})\|([\s\S]*)\|(\d[\d.e+-]*)$/.exec(key);
  if (!r) return null;
  const status = +r[3];
  return { kind: "request", method: r[1], path: r[2], status, title: `${r[1]} ${r[2]} answers ${status}`, noise: (isScannerPath(r[2]) && status < 500) || isNoise(`${r[1]} ${r[2]} ${status}`) };
}

/** The fields read are named one by one, so a `__proto__` or `constructor` in the file is never looked at. */
function readGroup(raw: unknown, now: number, zeros: number, isNoise: (label: string) => boolean): Group {
  const k = (n: string): unknown => (raw as Record<string, unknown>)[n];
  const opt = (n: string, f: (v: unknown) => unknown): unknown => (k(n) === undefined ? undefined : f(k(n)));
  const key = k("key");
  // The id vouches for the key, and the key for what the group is.
  if (!clean(key) || k("id") !== shortId(key)) bad();
  const g: Record<string, unknown> = { ...(seedOf(key, isNoise) ?? bad()), key, id: k("id"), hits: 0, entering: "seen", fixed: k("fixed") === true };
  for (const n of NUMS) g[n] = int(k(n));
  for (const n of ["firstMs", "lastMs", "sentAt"]) g[n] = Math.min(g[n] as number, now);
  g.sentTotal = Math.min(g.sentTotal as number, g.total as number);
  g.sample = text(k("sample"), MAX_SAMPLE);
  g.service = opt("service", name) || undefined;
  g.known = opt("known", (v) => text(v, 200));
  // Not what the last batch said (it is not kept): a restart makes a repeat `seen`.
  g.last = g.noise ? "noise" : g.known !== undefined ? "known" : "seen";
  // A name that is none any more (an older version kept `[hex]` for a commit) is left out, the rest stays.
  g.releases = [...new Set((k("releases") as unknown[]).slice(0, MAX_RELEASES).map(name).filter(Boolean))];
  g.counts = [...(k("counts") as unknown[]).slice(-COUNT_BATCHES).map(int), ...Array<number>(zeros).fill(0)].slice(-COUNT_BATCHES);
  const fam = k("families") as Record<string, unknown> | undefined;
  g.families = {};
  for (const n of FAMILIES) if (fam?.[n] !== undefined) (g.families as Record<string, number>)[n] = int(fam[n]);
  return g as unknown as Group;
}

/**
 * The groups, marks and per-day count in what a store returned, or null when it is not a state of this version. A group
 * or a mark that is not whole is left out alone. One zero goes into every group's counts for each batch window between
 * the save and `now`.
 */
export function loadState(raw: unknown, now: number, maxGroups: number, isNoise: (label: string) => boolean): Loaded | null {
  try {
    const { version, savedAt, batchMinutes, groups: gs, marks: ms, cloud } = raw as Record<string, unknown>;
    // A bad or negative `batchMinutes` or `savedAt` makes this NaN or negative.
    const zeros = Math.min(COUNT_BATCHES, Math.floor((now - Math.min(Date.parse(savedAt as string), now)) / ((batchMinutes as number) * 60_000)));
    if (version !== 1 || typeof savedAt !== "string" || typeof batchMinutes !== "number" || !(batchMinutes >= 1) || !Array.isArray(gs) || !Array.isArray(ms) || !(zeros >= 0)) return null;
    // A file this monitor wrote has no more groups than `limits.groups`: past a few times that, the rest is not looked at.
    const groups: Group[] = [];
    const marks: Loaded["marks"] = [];
    for (const raw of gs.slice(0, maxGroups * 4 + 2000)) {
      try {
        const g = readGroup(raw, now, zeros, isNoise);
        if (now - g.lastMs <= FORGET_MS) groups.push(g);
      } catch {
        // this group only
      }
    }
    for (const mark of ms.slice(-MAX_MARKS)) {
      try {
        const { id, known, fixed } = mark as Record<string, unknown>;
        marks.push([clean(id) ? id : bad(), { known: known === undefined ? undefined : text(known, 200), fixed: fixed === true || undefined }]);
      } catch {
        // this mark only
      }
    }
    return { groups: groups.sort((a, b) => b.total - a.total || b.lastMs - a.lastMs).slice(0, maxGroups), marks, cloud };
  } catch {
    return null;
  }
}

/**
 * The state to save: what the monitor holds, nothing more. Strings are redacted already; only what the app typed
 * (a mark's note and id, a group's note) is redacted here, and a group whose key `redact` would change is not kept. The open batch's hits are left out: they are judged in the next run.
 */
export function exportState(groups: Iterable<Group>, marks: Map<string, MarkOptions>, now: number, batchMinutes: number, cloud: LogState["cloud"] = { day: "", sent: 0 }): LogState {
  const gs: LogStateGroup[] = [];
  for (const g of groups) {
    const o = { ...g, total: g.total - g.hits, releases: [...g.releases], counts: g.counts, families: { ...g.families } } as Record<string, unknown>;
    if (g.known !== undefined) o.known = redact(g.known).slice(0, 200);
    for (const n of NUMS) o[n] = Math.min(Math.round((o[n] as number | undefined) ?? 0), MAX_N);
    delete o.hits;
    delete o.entering;
    if ((o.total as number) > 0 && clean(g.key)) gs.push(o as unknown as LogStateGroup);
  }
  const mk: LogStateMark[] = [];
  for (const [id, m] of marks) if (clean(id)) mk.push({ id, known: typeof m.known === "string" ? redact(m.known).slice(0, 200) : undefined, fixed: m.fixed });
  return { version: 1, savedAt: new Date(now).toISOString(), batchMinutes, groups: gs, marks: mk, cloud };
}
