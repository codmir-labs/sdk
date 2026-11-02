import { addBreadcrumb, getClient } from "../overseer/index";
import { getActiveSpan } from "./context";
import { isIngestUrl, resolveUrl, shouldPropagate } from "./fetch";
import type { Span } from "./span";

export interface InstrumentXhrOptions {
  /** Record each request as an `xhr` breadcrumb, as the browser integration always did. Default true. */
  breadcrumbs?: boolean;
}

const INSTALLED = Symbol.for("@codmir/sdk.xhr-instrumented");
type XhrProto = typeof XMLHttpRequest.prototype;
type PatchedOpen = XhrProto["open"] & { [INSTALLED]?: XhrProto["open"] };

interface XhrState {
  /** As passed to `open`, for the breadcrumb. */
  rawMethod: string;
  method: string;
  rawUrl: string;
  url: URL | null;
  startTime: number;
  /** The caller set its own `traceparent`, which we leave alone like fetch does. */
  hasTraceparent: boolean;
}

/**
 * Patches `XMLHttpRequest.prototype` once: every request made while a span is active becomes an `http.client`
 * child span that ends on `loadend` (load, error, abort and timeout alike), mirroring `instrumentFetch`, including
 * the `traceparent` rules and leaving the Codmir ingest URL alone. Also records the `xhr` breadcrumb. Idempotent;
 * returns a function that restores the previous methods.
 */
export function instrumentXhr(options: InstrumentXhrOptions = {}): () => void {
  const { breadcrumbs = true } = options;
  if (typeof XMLHttpRequest === "undefined") return () => {};
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open as PatchedOpen;
  if (originalOpen[INSTALLED]) return () => {};
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  const states = new WeakMap<XMLHttpRequest, XhrState>();

  const open: PatchedOpen = function (this: XMLHttpRequest, method: string, url: string | URL) {
    const rawUrl = String(url);
    states.set(this, { rawMethod: String(method), method: String(method).toUpperCase(), rawUrl, url: resolveUrl(rawUrl), startTime: 0, hasTraceparent: false });
    // eslint-disable-next-line prefer-rest-params -- forwards every XHR open() argument unchanged
    return (originalOpen as (...args: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
  } as PatchedOpen;
  open[INSTALLED] = originalOpen;

  const setRequestHeader: XhrProto["setRequestHeader"] = function (this: XMLHttpRequest, name: string, value: string) {
    const state = states.get(this);
    if (state && name.toLowerCase() === "traceparent") state.hasTraceparent = true;
    return originalSetRequestHeader.call(this, name, value);
  };

  const send: XhrProto["send"] = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const state = states.get(this);
    if (!state) return originalSend.call(this, body);
    state.startTime = Date.now();

    let span: Span | null = null;
    if (state.url && !isIngestUrl(state.url)) {
      span = getActiveSpan()?.startChild({ op: "http.client", name: `${state.method} ${state.url.pathname}` }) ?? null;
      span?.setData("url", `${state.url.origin}${state.url.pathname}`);
      span?.setData("http.request.method", state.method);
      if (span && !state.hasTraceparent && shouldPropagate(state.url, getClient()?.getTracePropagationTargets() ?? [])) {
        originalSetRequestHeader.call(this, "traceparent", span.toTraceparent());
      }
    }

    this.addEventListener(
      "loadend",
      () => {
        if (span) {
          // Status 0 is a network error, abort or timeout: no response came back.
          if (this.status > 0) span.setData("http.response.status_code", this.status);
          span.setStatus(this.status > 0 && this.status < 400 ? "ok" : "error");
          span.end();
        }
        if (breadcrumbs) {
          addBreadcrumb({
            category: "xhr",
            message: `${state.rawMethod} ${state.rawUrl}`,
            data: { method: state.rawMethod, url: state.rawUrl, status: this.status, duration: Date.now() - state.startTime },
            level: this.status >= 400 ? "error" : "info",
          });
        }
      },
      { once: true },
    );

    return originalSend.call(this, body);
  };

  proto.open = open;
  proto.send = send;
  proto.setRequestHeader = setRequestHeader;
  return () => {
    if (proto.open === open) proto.open = originalOpen;
    if (proto.send === send) proto.send = originalSend;
    if (proto.setRequestHeader === setRequestHeader) proto.setRequestHeader = originalSetRequestHeader;
  };
}
