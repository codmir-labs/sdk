import { addBreadcrumb, getClient } from "../overseer/index";
import { isLive, type Installed } from "../overseer/lifecycle";
import { scrubUrlsIn } from "../overseer/url-scrub";
import { getActiveSpan } from "./context";
import { isSdkRequest, requestPath, resolveUrl, scrubRequestUrl, shouldPropagate } from "./url-match";

export { resolveUrl, shouldPropagate };

export interface InstrumentFetchOptions {
  /** Record each request as a `fetch` breadcrumb, as the browser integration always did. Default true. */
  breadcrumbs?: boolean;
}

const INSTALLED = Symbol.for("@codmir/sdk.fetch-instrumented");
type PatchedFetch = typeof fetch & { [INSTALLED]?: Installed };

/** Whether a request is one the SDK makes itself (errors, replay, feedback) for the running client: never a breadcrumb or span. */
export function isOwnRequest(url: URL): boolean {
  const ingest = getClient()?.getIngestUrl();
  return !!ingest && isSdkRequest(url, ingest);
}

/**
 * Wraps `globalThis.fetch` (browser, and Node 18+): every request made while a span is active becomes an
 * `http.client` child span and, for same-origin URLs and `tracePropagationTargets`, carries a `traceparent`
 * header naming that span. The SDK's own requests (ingest, replay, feedback) are left completely alone. Idempotent while its wrapper
 * works; returns a function that restores the previous fetch if the wrapper is on top, and otherwise leaves the wrapper
 * in place, passing every call on, so a patch over it (a second copy of the SDK) keeps working.
 */
export function instrumentFetch(options: InstrumentFetchOptions = {}): () => void {
  const { breadcrumbs = true } = options;
  const g = globalThis as { fetch?: PatchedFetch };
  const original = g.fetch;
  if (typeof original !== "function") return () => {};
  if (isLive(original, INSTALLED)) return () => {};
  const installed: Installed = { active: true };

  const wrapped: PatchedFetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!installed.active) return original.call(globalThis, input, init);
    const fullUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // The breadcrumb names origin and path only: a query or fragment can hold a token.
    const rawUrl = scrubRequestUrl(fullUrl);
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "") || "GET").toUpperCase();
    const url = resolveUrl(fullUrl);
    const path = url ? requestPath(url, rawUrl) : "";
    if (!url || isOwnRequest(url)) return original.call(globalThis, input, init);

    const parent = getActiveSpan();
    const span = parent?.startChild({ op: "http.client", name: `${method} ${path}` }) ?? null;
    span?.setData("url", rawUrl);
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
          message: `${method} ${path} ${response.status}`,
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
          message: `${method} ${path} failed`,
          data: {
            method,
            url: rawUrl,
            error: error instanceof Error ? scrubUrlsIn(error.message) : "Network error",
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
  wrapped[INSTALLED] = installed;

  g.fetch = wrapped;
  return () => {
    installed.active = false;
    if (g.fetch === wrapped) g.fetch = original;
  };
}
