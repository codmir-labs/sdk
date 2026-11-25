/**
 * Wire types for tracing. They mirror `SpanSchema` and `TransactionEventSchema` in the platform's
 * analytics schemas; the tests validate against a copy of that schema.
 */

export type SpanStatus = "ok" | "error" | "cancelled" | "unknown";

export interface SpanEvent {
  span_id: string;
  parent_span_id?: string;
  op: string;
  description?: string;
  status: SpanStatus;
  start_timestamp: string;
  end_timestamp: string;
  tags?: Record<string, string>;
  data?: Record<string, unknown>;
}

/** Web vitals, mirroring `TransactionMeasurementsSchema`: milliseconds, except `cls` (unitless). */
export interface TransactionMeasurements {
  lcp?: number;
  inp?: number;
  cls?: number;
  ttfb?: number;
  fcp?: number;
}

export interface TransactionEvent {
  type: "transaction";
  event_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  op: string;
  name: string;
  status: SpanStatus;
  start_timestamp: string;
  end_timestamp: string;
  spans: SpanEvent[];
  measurements?: TransactionMeasurements;
  tags?: Record<string, string>;
  release?: string;
  environment?: string;
  sdk?: { name: string; version: string };
}

/** Most spans one transaction may carry; the server rejects more. */
export const MAX_SPANS_PER_TRANSACTION = 1000;
