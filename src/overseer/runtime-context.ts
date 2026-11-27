/**
 * The `contexts` and `request` an error event carries, with the field names the platform's ingest allowlist
 * reads: browser, os, runtime and device, each with name, version, family, type.
 * Nothing here reads headers, cookies, a body or a query string.
 */

import { routeFragment } from "./url-scrub";

export interface ContextEntry {
  name?: string;
  version?: string;
  family?: string;
  type?: string;
}
export type EnvContexts = Partial<Record<"browser" | "os" | "runtime" | "device", ContextEntry>>;

interface UaData {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
}

const clean = (e: ContextEntry): ContextEntry | undefined => {
  const out: ContextEntry = {};
  for (const [k, v] of Object.entries(e)) if (typeof v === "string" && v) out[k as keyof ContextEntry] = v;
  return Object.keys(out).length ? out : undefined;
};

const BRAND_NAMES: Array<[RegExp, string]> = [
  [/edge/i, "Edge"],
  [/opera/i, "Opera"],
  [/chrome/i, "Chrome"],
  [/firefox/i, "Firefox"],
  [/safari/i, "Safari"],
];

/** A small userAgent parse for Chrome, Edge, Opera, Firefox, Safari, on iOS and Android too. No dependency. */
export function parseUserAgent(ua: string, uaData?: UaData): EnvContexts {
  let browser: ContextEntry = {};
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re);
    if (m) browser = { name, version: m[1] };
    return !!m;
  };
  // Order matters: Edge, Opera and the iOS shells all say "Chrome" or "Safari" as well.
  const matchers: Array<[RegExp, string]> = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/FxiOS\/([\d.]+)/, "Firefox"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/CriOS\/([\d.]+)/, "Chrome"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ];
  for (const [re, name] of matchers) if (pick(re, name)) break;

  let os: ContextEntry = {};
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) os = { name: "Windows", version: m[1] };
  else if ((m = ua.match(/(?:iPhone|CPU) OS ([\d_]+)/)) || (m = ua.match(/iPad.*OS ([\d_]+)/))) os = { name: "iOS", version: m[1]!.replace(/_/g, ".") };
  else if ((m = ua.match(/Android ([\d.]+)/))) os = { name: "Android", version: m[1] };
  else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) os = { name: "macOS", version: m[1]!.replace(/_/g, ".") };
  else if (/CrOS/.test(ua)) os = { name: "ChromeOS" };
  else if (/Linux/.test(ua)) os = { name: "Linux" };

  const tablet = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
  const mobile = /Mobi|iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua));
  const device: ContextEntry = { type: tablet ? "tablet" : mobile ? "mobile" : "desktop" };
  if (/iPhone/.test(ua)) device.family = "iPhone";
  else if (/iPad/.test(ua)) device.family = "iPad";

  // userAgentData wins where it has an answer: the UA string is frozen or reduced in modern Chromium.
  if (uaData) {
    const brands = (uaData.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
    const specific = brands.find((b) => !/^chromium$/i.test(b.brand)) ?? brands[0];
    if (specific) {
      const named = BRAND_NAMES.find(([re]) => re.test(specific.brand));
      browser = { name: named ? named[1] : specific.brand, version: specific.version };
    }
    if (uaData.platform) os = { name: uaData.platform, version: os.name === uaData.platform ? os.version : undefined };
    if (uaData.mobile === true && device.type === "desktop") device.type = "mobile";
  }

  const out: EnvContexts = {};
  const b = clean(browser);
  const o = clean(os);
  if (b) out.browser = b;
  if (o) out.os = o;
  out.device = device;
  return out;
}

type Require = (id: string) => unknown;

/** A way to load a Node builtin without a static import, which a browser bundler could not resolve. Undefined outside Node. */
export function nodeBuiltin(): Require | undefined {
  const proc = typeof process !== "undefined" ? (process as unknown as { getBuiltinModule?: Require }) : undefined;
  if (!proc) return undefined;
  if (typeof proc.getBuiltinModule === "function") return (id) => proc.getBuiltinModule!.call(proc, id);
  if (typeof require === "function") {
    const r = require as unknown as Require;
    return (id) => r(id);
  }
  return undefined;
}

export function isNode(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string" && typeof window === "undefined";
}

function nodeContexts(): EnvContexts {
  const out: EnvContexts = { runtime: { name: "node", version: process.versions.node } };
  let version: string | undefined;
  try {
    version = (nodeBuiltin()?.("node:os") as { release(): string } | undefined)?.release();
  } catch {
    // os.release unavailable: the platform name alone still says something
  }
  const os = clean({ name: process.platform, version });
  if (os) out.os = os;
  return out;
}

function browserContexts(): EnvContexts {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userAgentData?: UaData }) : undefined;
  if (!nav?.userAgent) return {};
  return parseUserAgent(nav.userAgent, nav.userAgentData);
}

type Globals = {
  Deno?: { version?: { deno?: unknown } };
  EdgeRuntime?: unknown;
  HermesInternal?: { getRuntimeProperties?: () => Record<string, unknown> };
  navigator?: { userAgent?: unknown; product?: unknown };
};

/** What the app says about the OS of a React Native device: the runtime cannot tell without importing `react-native`. */
let appOs: ContextEntry | undefined;

/**
 * Sets the OS that React Native events carry, from what the app passes to `setDeviceInfo`. Ignored outside React
 * Native. `undefined` clears it.
 */
export function setAppOs(info: { platform?: string; osVersion?: string } | undefined): void {
  const name = info?.platform === "ios" ? "iOS" : info?.platform === "android" ? "Android" : info?.platform;
  appOs = info ? clean({ name, version: info.osVersion }) : undefined;
}

function reactNativeContexts(g: Globals): EnvContexts {
  const props = g.HermesInternal ? safely(() => g.HermesInternal?.getRuntimeProperties?.()) : undefined;
  const version = props?.["OSS Release Version"];
  const runtime = g.HermesInternal ? { name: "hermes", version: typeof version === "string" ? version : undefined } : { name: "react-native" };
  return { runtime: clean(runtime), device: { type: "mobile" } };
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Where the code runs, looked up in this order: Bun, Deno, edge-runtime (Next.js and Vercel Edge), workerd
 * (Cloudflare Workers), React Native, a browser, Node. Bun, Deno and Node 21+ all set `process.versions.node` or a
 * global `navigator`, so the first three kinds are checked before either is taken as proof of Node or a browser.
 */
function detect(): EnvContexts {
  const g = globalThis as unknown as Globals;
  const bun = typeof process !== "undefined" ? process.versions?.bun : undefined;
  if (typeof bun === "string") return { runtime: { name: "bun", version: bun } };
  const deno = g.Deno?.version?.deno;
  if (typeof deno === "string") return { runtime: { name: "deno", version: deno } };
  if (typeof g.EdgeRuntime === "string") return { runtime: { name: "edge-runtime" } };
  if (g.navigator?.userAgent === "Cloudflare-Workers") return { runtime: { name: "workerd" } };
  if (g.navigator?.product === "ReactNative") return reactNativeContexts(g);
  if (typeof window !== "undefined" && typeof document !== "undefined") return browserContexts();
  if (typeof process !== "undefined" && typeof process.versions?.node === "string") return nodeContexts();
  return {};
}

let cached: EnvContexts | undefined;

/**
 * Runtime, plus os and device where they are known: browser, os and device in a window; runtime and os in Node;
 * the runtime alone in Bun, Deno, edge-runtime and workerd; runtime, mobile device and the app's OS in React Native.
 * Computed once: none of it changes while the process lives.
 */
export function envContexts(): EnvContexts {
  if (!cached) cached = detect();
  return cached.runtime?.name === "hermes" || cached.runtime?.name === "react-native"
    ? { ...cached, ...(appOs ? { os: appOs } : {}) }
    : cached;
}

/** For tests. */
export function resetEnvContexts(): void {
  cached = undefined;
}

/** The page's origin and path in a browser, plus a route fragment (`#/settings`): no query, no other hash, no credentials. Node has no request in scope here, so none. */
export function browserRequest(): { url: string } | undefined {
  if (typeof window === "undefined" || !window.location) return undefined;
  const { protocol, host, pathname, hash } = window.location;
  if (!protocol) return undefined;
  return { url: `${protocol}//${host}${pathname}${routeFragment(hash ?? "")}` };
}
