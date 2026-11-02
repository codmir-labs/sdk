import { addBreadcrumb, getClient } from "../overseer/index";
import { getActiveSpan } from "./context";

export interface InstrumentFetchOptions {
  /** Record each request as a `fetch` breadcrumb, as the browser integration always did. Default true. */
  breadcrumbs?: boolean;
}

const INSTALLED = Symbol.for("@codmir/sdk.fetch-instrumented");
type PatchedFetch = typeof fetch & { [INSTALLED]?: typeof fetch };

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

export function isIngestUrl(url: URL): boolean {
  const ingest = getClient()?.getIngestUrl();
  if (!ingest) return false;
  const target = resolveUrl(ingest);
  return !!target && url.origin === target.origin && url.pathname === target.pathname;
}

/**
 * Wraps `globalThis.fetch` (browser, and Node 18+): every request made while a span is active becomes an
 * `http.client` child span and, for same-origin URLs and `tracePropagationTargets`, carries a `traceparent`
 * header naming that span. Requests to the Codmir ingest URL are left completely alone. Idempotent; returns a
 * function that restores the previous fetch.
 */
export function instrumentFetch(options: InstrumentFetchOptions = {}): () => void {
  const { breadcrumbs = true } = options;
  const g = globalThis as { fetch?: PatchedFetch };
  const original = g.fetch;
  if (typeof original !== "function") return () => {};
  if (original[INSTALLED]) return () => {};

  const wrapped: PatchedFetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "") || "GET").toUpperCase();
    const url = resolveUrl(rawUrl);
    if (!url || isIngestUrl(url)) return original.call(globalThis, input, init);

    const parent = getActiveSpan();
    const span = parent?.startChild({ op: "http.client", name: `${method} ${url.pathname}` }) ?? null;
    span?.setData("url", `${url.origin}${url.pathname}`);
    span?.setData("http.request.method", method);

    let nextInit = init;
    if (span && shouldPropagate(url, getClient()?.getTracePropagationTargets() ?? [])) {
      const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
      if (!headers.has("traceparent")) {
        headers.set("traceparent", span.toTraceparent());
        nextInit = { ...init, headers };
      }
    }

    const started = Date.now();
    try {
      const response = await original.call(globalThis, input, nextInit);
      span?.setData("http.response.status_code", response.status);
      span?.setStatus(response.status >= 400 ? "error" : "ok");
      if (breadcrumbs) {
        addBreadcrumb({
          category: "fetch",
          message: `${method} ${rawUrl}`,
          data: { method, url: rawUrl, status: response.status, duration: Date.now() - started },
          level: response.ok ? "info" : "error",
        });
      }
      return response;
    } catch (error) {
      span?.setStatus("error");
      if (breadcrumbs) {
        addBreadcrumb({
          category: "fetch",
          message: `${method} ${rawUrl}`,
          data: {
            method,
            url: rawUrl,
            error: error instanceof Error ? error.message : "Network error",
            duration: Date.now() - started,
          },
          level: "error",
        });
      }
      throw error;
    } finally {
      span?.end();
    }
  };
  wrapped[INSTALLED] = original;

  g.fetch = wrapped;
  return () => {
    if (g.fetch === wrapped) g.fetch = original;
  };
}
