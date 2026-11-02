import { nanoid } from "nanoid";
import { generateSpanId, formatTraceparent } from "./propagation";
import { MAX_SPANS_PER_TRANSACTION, type SpanEvent, type SpanStatus, type TransactionEvent } from "./types";

export interface SpanOptions {
  op: string;
  name: string;
  tags?: Record<string, string>;
  data?: Record<string, unknown>;
}

/** Where a finished transaction goes. `tracing/index.ts` wires it to the Overseer client's transport. */
export type TransactionSink = (event: TransactionEvent) => void;

/** Collects the finished child spans of one trace inside its root transaction. */
interface Recorder {
  spans: SpanEvent[];
  dropped: number;
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  op: string;
  name: string;
  status: SpanStatus = "ok";
  tags: Record<string, string>;
  data: Record<string, unknown>;
  readonly startMs: number;
  endMs?: number;
  protected recorder: Recorder;

  constructor(
    options: SpanOptions,
    ids: { traceId: string; parentSpanId?: string; sampled: boolean },
    recorder: Recorder,
  ) {
    this.op = options.op;
    this.name = options.name;
    this.tags = { ...options.tags };
    this.data = { ...options.data };
    this.traceId = ids.traceId;
    this.parentSpanId = ids.parentSpanId;
    this.spanId = generateSpanId();
    this.sampled = ids.sampled;
    this.recorder = recorder;
    this.startMs = Date.now();
  }

  get isEnded(): boolean {
    return this.endMs !== undefined;
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  setData(key: string, value: unknown): void {
    this.data[key] = value;
  }

  /** The value for an outgoing `traceparent` header: this span is the remote side's parent. */
  toTraceparent(): string {
    return formatTraceparent(this.traceId, this.spanId, this.sampled);
  }

  startChild(options: SpanOptions): Span {
    return new Span(options, { traceId: this.traceId, parentSpanId: this.spanId, sampled: this.sampled }, this.recorder);
  }

  /** Ends the span once; later calls do nothing. */
  end(): void {
    if (this.endMs !== undefined) return;
    this.endMs = Math.max(Date.now(), this.startMs);
    if (!this.sampled) return;
    if (this.recorder.spans.length >= MAX_SPANS_PER_TRANSACTION - 1) {
      this.recorder.dropped++;
      return;
    }
    this.recorder.spans.push(this.toSpanEvent());
  }

  protected toSpanEvent(): SpanEvent {
    const span: SpanEvent = {
      span_id: this.spanId,
      op: clip(this.op, 64) || "unknown",
      status: this.status,
      start_timestamp: new Date(this.startMs).toISOString(),
      end_timestamp: new Date(this.endMs ?? this.startMs).toISOString(),
    };
    if (this.parentSpanId) span.parent_span_id = this.parentSpanId;
    if (this.name) span.description = clip(this.name, 1024);
    const tags = clipTags(this.tags);
    if (tags) span.tags = tags;
    if (Object.keys(this.data).length > 0) span.data = this.data;
    return span;
  }
}

export interface TransactionContext {
  release?: string;
  environment?: string;
  sdk?: { name: string; version: string };
  tags?: Record<string, string>;
}

/** A root span. Ending it serializes the whole tree as one transaction event, when the trace is sampled. */
export class Transaction extends Span {
  constructor(
    options: SpanOptions,
    ids: { traceId: string; parentSpanId?: string; sampled: boolean },
    private readonly sink: TransactionSink,
    private readonly context: () => TransactionContext,
  ) {
    super(options, ids, { spans: [], dropped: 0 });
  }

  override end(): void {
    if (this.endMs !== undefined) return;
    this.endMs = Math.max(Date.now(), this.startMs);
    if (!this.sampled) return;
    this.sink(this.toTransactionEvent());
  }

  /** The serialized form; exactly the fields of the server's `TransactionEventSchema`. */
  toTransactionEvent(): TransactionEvent {
    const ctx = this.context();
    const tx: TransactionEvent = {
      type: "transaction",
      event_id: nanoid(),
      trace_id: this.traceId,
      span_id: this.spanId,
      op: clip(this.op, 64) || "unknown",
      name: clip(this.name, 256) || "unknown",
      status: this.status,
      start_timestamp: new Date(this.startMs).toISOString(),
      end_timestamp: new Date(this.endMs ?? this.startMs).toISOString(),
      spans: [...this.recorder.spans],
    };
    if (this.parentSpanId) tx.parent_span_id = this.parentSpanId;
    const tags = clipTags({ ...ctx.tags, ...this.tags });
    if (tags) tx.tags = tags;
    if (ctx.release) tx.release = ctx.release.slice(0, 64);
    if (ctx.environment) tx.environment = ctx.environment.slice(0, 32);
    if (ctx.sdk) tx.sdk = ctx.sdk;
    return tx;
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Tag keys are limited to 64 characters and values to 256; the server rejects the whole event otherwise. */
function clipTags(tags: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(tags).filter(([, v]) => typeof v === "string");
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [clip(k, 64), clip(v, 256)]));
}
