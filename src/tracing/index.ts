/**
 * @codmir/sdk tracing (CSL-5575): spans, W3C `traceparent` propagation and sampling.
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
 * per trace at that root, and the answer travels downstream in the `traceparent` sampled flag.
 */

import { getClient } from "../overseer/index";
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
export type { SpanEvent, SpanStatus, TransactionEvent } from "./types";
export { instrumentFetch } from "./fetch";
export type { InstrumentFetchOptions } from "./fetch";

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
}

/**
 * Starts a root transaction. The caller ends it with `end()`. Sampling: `tracesSampleRate` 0 (the default)
 * records nothing, even when the caller sent a sampled `traceparent`; otherwise an incoming `traceparent`'s
 * sampled flag wins, and with none the trace is sampled with probability `tracesSampleRate`.
 */
export function startTransaction(options: StartTransactionOptions): Transaction {
  const incoming: TraceparentData | null = parseTraceparent(options.traceparent);
  const client = getClient();
  const rate = client && client.isEnabled() ? client.getTracesSampleRate() : 0;
  const sampled = rate > 0 && (incoming ? incoming.sampled : Math.random() < rate);

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
