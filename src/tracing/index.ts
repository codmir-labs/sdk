/**
 * @codmir/sdk tracing: spans, W3C `traceparent` propagation and sampling.
 *
 * ```ts
 * init({ clientKey, tracesSampleRate: 0.2 });
 * await startSpan({ name: "checkout", op: "function" }, async () => {
 *   await startSpan({ name: "charge card", op: "payment" }, () => charge());
 * });
 * ```
 *
 * The first span with no active parent is a root transaction; when it ends, it and its finished children are
 * queued as one `transaction` event on the Overseer transport. `tracesSampleRate` (default 0) is applied once
 * per trace at that root (by `tracesSampler` when set), and the answer travels downstream in the `traceparent` sampled flag.
 */

import { getClient, type TracesSamplerContext } from "../overseer/index";
import { getActiveSpan, withActiveSpan, isThenable } from "./context";
import { generateTraceId, parseTraceparent, type TraceparentData } from "./propagation";
import { Span, Transaction, type SpanOptions, type TransactionContext } from "./span";
import { SDK_INFO as SDK } from "../version";

export { parseTraceparent, formatTraceparent, generateTraceId, generateSpanId } from "./propagation";
export type { TraceparentData } from "./propagation";
export { getActiveSpan, withActiveSpan, setContextStrategy } from "./context";
export type { ContextStrategy } from "./context";
export { Span, Transaction } from "./span";
export type { SpanOptions } from "./span";
export type { TracesSamplerContext } from "../overseer/index";
export type { SpanEvent, SpanStatus, TransactionEvent } from "./types";
export { instrumentFetch } from "./fetch";
export type { InstrumentFetchOptions } from "./fetch";
export { instrumentXhr } from "./xhr";
export type { InstrumentXhrOptions } from "./xhr";

// =============================================================================
// Transactions and spans
// =============================================================================

function transactionContext(): TransactionContext {
  const client = getClient();
  return {
    release: client?.getRelease(),
    environment: client?.getEnvironment(),
    sdk: SDK,
    tags: client?.getTags(),
  };
}

export interface StartTransactionOptions extends SpanOptions {
  /** An incoming `traceparent` header value: continue that trace, inheriting its sampling decision. */
  traceparent?: string | null;
  /** The request a server integration is serving, given to `tracesSampler`: the method, and the URL without its query string. */
  request?: { method: string; url: string };
}

/**
 * Starts a root transaction. The caller ends it with `end()`. With `tracesSampler` set it decides the root, and wins
 * over `tracesSampleRate`. Without one: `tracesSampleRate` 0 (the default) records nothing, even when the caller sent
 * a sampled `traceparent`; otherwise an incoming `traceparent`'s sampled flag wins, and with none the trace is
 * sampled with probability `tracesSampleRate`.
 */
export function startTransaction(options: StartTransactionOptions): Transaction {
  const incoming: TraceparentData | null = parseTraceparent(options.traceparent);
  const client = getClient();
  let sampled = false;
  if (client && client.isEnabled()) {
    const context: TracesSamplerContext = { name: options.name, op: options.op };
    if (incoming) context.parentSampled = incoming.sampled;
    if (options.request) context.request = { method: options.request.method, url: options.request.url };
    const chance = client.runTracesSampler(context);
    if (chance !== undefined) {
      sampled = chance > 0 && Math.random() < chance;
    } else {
      const rate = client.getTracesSampleRate();
      sampled = rate > 0 && (incoming ? incoming.sampled : Math.random() < rate);
    }
  }

  return new Transaction(
    options,
    { traceId: incoming?.traceId ?? generateTraceId(), parentSpanId: incoming?.spanId, sampled },
    (event) => getClient()?.captureTransaction(event),
    transactionContext,
  );
}

/** A child of the active span, or null when none is active (so nothing is recorded outside a trace). */
export function startChildSpan(options: SpanOptions): Span | null {
  return getActiveSpan()?.startChild(options) ?? null;
}

/**
 * Runs `fn` inside a new span and ends it when `fn` returns, throws, or its promise settles. Nests under the
 * active span; with none active it opens a root transaction. A throw or rejection marks the span `error` and
 * propagates unchanged.
 */
export function startSpan<T>(options: SpanOptions, fn: (span: Span) => T): T {
  const parent = getActiveSpan();
  const span = parent ? parent.startChild(options) : startTransaction(options);

  let result: T;
  try {
    result = withActiveSpan(span, () => fn(span));
  } catch (err) {
    span.setStatus("error");
    span.end();
    throw err;
  }

  if (isThenable(result)) {
    return result.then(
      (value) => {
        span.end();
        return value;
      },
      (err: unknown) => {
        span.setStatus("error");
        span.end();
        throw err;
      },
    ) as T;
  }
  span.end();
  return result;
}
