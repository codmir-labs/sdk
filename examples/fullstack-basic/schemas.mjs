/**
 * Wire schemas the capture server validates against: Zod copies of the platform's own contracts.
 *
 * Source: codmir-labs/platform-v2 `origin/development` @ 7ad8cc79e41066cfdc771883a9a6f1191aa770fa
 *   - packages/types/src/api/overseer-replay.ts  (ReplaySegmentUploadSchema, ReplayUploadResponseSchema)
 *   - packages/types/src/api/overseer-ingest.ts  (error event shapes)
 *   - packages/types/src/api/analytics.ts        (TelemetryIngestBodySchema, TransactionEventSchema)
 * Copied, not imported: the platform repo is private. When those files change, change this one too.
 */
import { z } from "zod";

// ── overseer-replay.ts ──────────────────────────────────────
export const REPLAY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const REPLAY_MAX_EVENTS_PER_SEGMENT = 10_000;
export const REPLAY_MAX_ERROR_EVENT_IDS = 500;

export const ReplayEventSchema = z.object({ type: z.number(), timestamp: z.number() }).passthrough();
export const ReplayIdSchema = z.string().uuid();

export const ReplaySegmentUploadSchema = z.object({
  replay_id: ReplayIdSchema,
  segment: z.number().int().min(0).max(1_000_000),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  environment: z.string().max(200).optional(),
  release: z.string().max(200).optional(),
  error_event_ids: z.array(z.string().min(1).max(64)).max(REPLAY_MAX_ERROR_EVENT_IDS).default([]),
  sdk: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(50) }),
  events: z.array(ReplayEventSchema).max(REPLAY_MAX_EVENTS_PER_SEGMENT),
});

export const ReplayUploadResponseSchema = z.object({
  stored: z.boolean(),
  reason: z.enum(["payment_required", "insufficient_credits"]).optional(),
});

// ── overseer-ingest.ts ──────────────────────────────────────
export const OverseerSeveritySchema = z.enum(["fatal", "error", "warning", "info", "debug"]);

export const OverseerSdkStackFrameSchema = z
  .object({
    filename: z.string().optional(),
    function: z.string().optional(),
    lineno: z.number().optional(),
    colno: z.number().optional(),
    in_app: z.boolean().optional(),
    context_line: z.string().optional(),
    pre_context: z.array(z.string()).optional(),
    post_context: z.array(z.string()).optional(),
  })
  .passthrough();

export const OverseerSdkExceptionSchema = z
  .object({
    type: z.string(),
    value: z.string(),
    stacktrace: z.array(OverseerSdkStackFrameSchema).optional(),
    mechanism: z.object({ type: z.string(), handled: z.boolean() }).passthrough().optional(),
  })
  .passthrough();

export const OverseerSdkErrorEventSchema = z
  .object({
    id: z.string(),
    type: z.literal("error"),
    timestamp: z.string(),
    level: OverseerSeveritySchema,
    message: z.string().optional(),
    exception: OverseerSdkExceptionSchema.optional(),
    user: z.record(z.string(), z.unknown()).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
    breadcrumbs: z.array(z.record(z.string(), z.unknown())).optional(),
    contexts: z.record(z.string(), z.unknown()).optional(),
    request: z.record(z.string(), z.unknown()).optional(),
    sdk: z.object({ name: z.string(), version: z.string() }).optional(),
    environment: z.string().optional(),
    release: z.string().optional(),
    fingerprint: z.array(z.string()).optional(),
  })
  .passthrough();

export const OverseerWrapperErrorEventSchema = z.object({
  type: z.literal("error"),
  event: z
    .object({
      id: z.string().optional(),
      message: z.string().optional(),
      level: z.string().optional(),
      environment: z.string().optional(),
      service: z.string().optional(),
      release: z.string().optional(),
      fingerprint: z.array(z.string()).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .optional(),
  group: z
    .object({
      id: z.string().optional(),
      fingerprint: z.union([z.array(z.string()), z.string()]).optional(),
      message: z.string().optional(),
      culprit: z.string().optional(),
      level: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

// ── analytics.ts ────────────────────────────────────────────
export const TelemetryIngestBodySchema = z.object({
  sessionId: z.string().max(128).optional(),
  service: z.string().max(64).optional(),
  environment: z.string().max(32).optional(),
  release: z.string().max(64).optional(),
  events: z.array(z.unknown()).max(500),
});

export const TRANSACTION_EVENT_TYPE = "transaction";
export const MAX_SPANS_PER_TRANSACTION = 1000;

export const TraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "trace_id must be 32 lowercase hex characters")
  .refine((v) => !/^0+$/.test(v), "trace_id must not be all zero");
export const SpanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "span_id must be 16 lowercase hex characters")
  .refine((v) => !/^0+$/.test(v), "span_id must not be all zero");

export const SpanStatusSchema = z.enum(["ok", "error", "cancelled", "unknown"]);
const TagsSchema = z.record(z.string().max(64), z.string().max(256));

export const SpanSchema = z
  .object({
    span_id: SpanIdSchema,
    parent_span_id: SpanIdSchema.optional(),
    op: z.string().min(1).max(64),
    description: z.string().max(1024).optional(),
    status: SpanStatusSchema.default("ok"),
    start_timestamp: z.string().datetime({ offset: true }),
    end_timestamp: z.string().datetime({ offset: true }),
    tags: TagsSchema.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((s) => Date.parse(s.end_timestamp) >= Date.parse(s.start_timestamp), {
    message: "end_timestamp must not be before start_timestamp",
    path: ["end_timestamp"],
  });

export const TransactionMeasurementsSchema = z
  .object({
    lcp: z.number().nonnegative().optional(),
    inp: z.number().nonnegative().optional(),
    cls: z.number().nonnegative().optional(),
    ttfb: z.number().nonnegative().optional(),
    fcp: z.number().nonnegative().optional(),
  })
  .strict();

export const TransactionEventSchema = z
  .object({
    type: z.literal(TRANSACTION_EVENT_TYPE),
    event_id: z.string().min(1).max(64),
    trace_id: TraceIdSchema,
    span_id: SpanIdSchema,
    parent_span_id: SpanIdSchema.optional(),
    op: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    status: SpanStatusSchema.default("ok"),
    start_timestamp: z.string().datetime({ offset: true }),
    end_timestamp: z.string().datetime({ offset: true }),
    spans: z.array(SpanSchema).max(MAX_SPANS_PER_TRANSACTION).default([]),
    measurements: TransactionMeasurementsSchema.optional(),
    tags: TagsSchema.optional(),
    release: z.string().max(64).optional(),
    environment: z.string().max(32).optional(),
    sdk: z.object({ name: z.string().max(64), version: z.string().max(32) }).optional(),
  })
  .refine((t) => Date.parse(t.end_timestamp) >= Date.parse(t.start_timestamp), {
    message: "end_timestamp must not be before start_timestamp",
    path: ["end_timestamp"],
  })
  .refine((t) => new Set(t.spans.map((s) => s.span_id)).size === t.spans.length, {
    message: "spans must not repeat a span_id",
    path: ["spans"],
  });
