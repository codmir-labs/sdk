import { addBreadcrumb, getClient } from "../overseer/index";
import { scrubUrl } from "../overseer/url-scrub";
import { getActiveSpan } from "./context";
import { resolveUrl, shouldPropagate } from "./url-match";

export { resolveUrl, shouldPropagate };

export interface InstrumentFetchOptions {
  /** Record each request as a `fetch` breadcrumb, as the browser integration always did. Default true. */
  breadcrumbs?: boolean;
}

const INSTALLED = Symbol.for("@codmir/sdk.fetch-instrumented");
type PatchedFetch = typeof fetch & { [INSTALLED]?: typeof fetch };

/** The ingest URL, and the feedback door next to it (`<base>/feedback`): requests the SDK makes itself are left alone. */
export function isIngestUrl(url: URL): boolean {
  const ingest = getClient()?.getIngestUrl();
  if (!ingest) return false;
  const target = resolveUrl(ingest);
  if (!target || url.origin !== target.origin) return false;
  if (url.pathname === target.pathname) return true;
  const feedback = `${target.pathname.replace(/\/ingest$/, "")}/feedback`;
  return url.pathname === feedback || url.pathname.startsWith(`${feedback}/`);
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
    const fullUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // The breadcrumb names origin and path only: a query or fragment can hold a token (CSL-5640).
    const rawUrl = scrubUrl(fullUrl);
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "") || "GET").toUpperCase();
    const url = resolveUrl(fullUrl);
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
