/** URL helpers shared by the request instrumentation and `@codmir/sdk/feedback`. Browser-safe, imports nothing. */

export function resolveUrl(raw: string): URL | null {
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/**
 * Whether a request is the SDK's own (errors, replay, feedback): on the origin of the DSN, under its base directory
 * (the DSN without a trailing `/ingest`), or the ingest URL itself. `dsn` is the DSN or the ingest URL.
 */
export function isSdkRequest(url: URL, dsn: string): boolean {
  const base = resolveUrl(dsn.replace(/(\/ingest)?\/*$/, ""));
  if (!base || url.origin !== base.origin) return false;
  if (url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) return true;
  const ingest = resolveUrl(/\/ingest$/.test(dsn) ? dsn : `${dsn.replace(/\/+$/, "")}/ingest`);
  return ingest?.origin === url.origin && ingest.pathname === url.pathname;
}

/** Same origin as the page, or a match for `tracePropagationTargets`. Relative URLs only resolve in a browser. */
export function shouldPropagate(url: URL, targets: Array<string | RegExp>): boolean {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin && url.origin === origin) return true;
  return targets.some((t) => (typeof t === "string" ? url.href.includes(t) : t.test(url.href)));
}
