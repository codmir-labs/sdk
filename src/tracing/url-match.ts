/** URL helpers shared by the request instrumentation and `@codmir/sdk/feedback`. Browser-safe, imports nothing. */

import { scrubUrl } from "../overseer/url-scrub";
import { feedbackUrl, ingestUrl, patchesManifestUrl, replayUrl } from "../endpoints";

export function resolveUrl(raw: string): URL | null {
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/**
 * `scrubUrl` for a request's URL. The page's address is the base only for a protocol-relative URL (`//user:pass@host/x`),
 * which cannot be told from a path without it; any other relative URL stays relative, as a breadcrumb always showed it.
 */
export function scrubRequestUrl(raw: string): string {
  const page = (globalThis as { location?: { href?: string } }).location?.href;
  return scrubUrl(raw, /^\s*[/\\]{2}/.test(raw) ? page : undefined);
}

/**
 * What a request breadcrumb names: the path of a URL with a host, else its scrubbed form (a `data:` URL's path is its whole
 * payload). `scrubbed` is the `scrubUrl` of the same URL.
 */
export function requestPath(url: URL, scrubbed: string): string {
  return url.href.startsWith(`${url.protocol}//`) ? url.pathname : scrubbed;
}

/**
 * Whether a request is one of the SDK's own endpoints (errors, replay, feedback, patch manifest): same origin and path
 * as one built in `../endpoints`, or under `<base>/feedback/`. The query never matters; nothing else on the DSN's
 * origin counts, whatever the DSN's path. `dsn` is the DSN or the ingest URL.
 */
export function isSdkRequest(url: URL, dsn: string): boolean {
  const same = (built: string): URL | null => {
    const u = resolveUrl(built);
    return u && u.origin === url.origin ? u : null;
  };
  const exact = [ingestUrl(dsn), replayUrl(dsn), patchesManifestUrl(dsn), feedbackUrl(dsn)];
  if (exact.some((built) => same(built)?.pathname === url.pathname)) return true;
  const feedback = same(feedbackUrl(dsn));
  return !!feedback && url.pathname.startsWith(`${feedback.pathname}/`);
}

/** Same origin as the page, or a match for `tracePropagationTargets`. Relative URLs only resolve in a browser. */
export function shouldPropagate(url: URL, targets: Array<string | RegExp>): boolean {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin && url.origin === origin) return true;
  return targets.some((t) => (typeof t === "string" ? url.href.includes(t) : t.test(url.href)));
}
