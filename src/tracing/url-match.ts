/** URL helpers shared by the request instrumentation and `@codmir/sdk/feedback`. Browser-safe, imports nothing. */

export function resolveUrl(raw: string): URL | null {
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/** Same origin as the page, or a match for `tracePropagationTargets`. Relative URLs only resolve in a browser. */
export function shouldPropagate(url: URL, targets: Array<string | RegExp>): boolean {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin && url.origin === origin) return true;
  return targets.some((t) => (typeof t === "string" ? url.href.includes(t) : t.test(url.href)));
}
