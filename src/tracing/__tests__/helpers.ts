import { z } from "zod";

// Copied from platform-v2 packages/types/src/api/analytics.ts (`TransactionEventSchema`, `SpanSchema`,
// `TraceIdSchema`, `SpanIdSchema`), as of commit 4c49b06f9 (platform-v2 PR #835). Keep in sync by hand.
const TraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "trace_id must be 32 lowercase hex characters")
  .refine((v) => !/^0+$/.test(v), "trace_id must not be all zero");
const SpanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "span_id must be 16 lowercase hex characters")
  .refine((v) => !/^0+$/.test(v), "span_id must not be all zero");
const SpanStatusSchema = z.enum(["ok", "error", "cancelled", "unknown"]);
const TagsSchema = z.record(z.string().max(64), z.string().max(256));
const SpanSchema = z
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
const TransactionMeasurementsSchema = z
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
    type: z.literal("transaction"),
    event_id: z.string().min(1).max(64),
    trace_id: TraceIdSchema,
    span_id: SpanIdSchema,
    parent_span_id: SpanIdSchema.optional(),
    op: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    status: SpanStatusSchema.default("ok"),
    start_timestamp: z.string().datetime({ offset: true }),
    end_timestamp: z.string().datetime({ offset: true }),
    spans: z.array(SpanSchema).max(1000).default([]),
    measurements: TransactionMeasurementsSchema.optional(),
    tags: TagsSchema.optional(),
    release: z.string().max(64).optional(),
    environment: z.string().max(32).optional(),
    sdk: z.object({ name: z.string().max(64), version: z.string().max(32) }).optional(),
  })
  .refine((t) => Date.parse(t.end_timestamp) >= Date.parse(t.start_timestamp), {
    message: "end_timestamp must not be before start_timestamp",
    path: ["end_timestamp"],
  });

export type FetchCall = { url: string; init?: RequestInit };

/** Every transaction event POSTed to the ingest URL so far. */
export function sentTransactions(calls: FetchCall[]): any[] {
  return calls
    .filter((c) => c.url.endsWith("/ingest"))
    .flatMap((c) => (JSON.parse(String(c.init?.body)).events ?? []) as any[])
    .filter((e) => e.type === "transaction");
}
