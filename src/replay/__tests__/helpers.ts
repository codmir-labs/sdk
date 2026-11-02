import { z } from "zod";

// Mirrors `ReplaySegmentUploadSchema` from the CSL-5611 wire contract (CONTRACT.md, "Body" and "Field rules"),
// which CSL-5611 adds to platform-v2 `@codmir/types`. Replace this with a copy of the merged schema, with its
// commit, once that PR lands, and keep in sync by hand like `TransactionEventSchema` in tracing/__tests__.
const ReplayEventSchema = z.object({ type: z.number(), timestamp: z.number() }).passthrough();

export const ReplaySegmentUploadSchema = z
  .object({
    replay_id: z.string().uuid(),
    segment: z.number().int().nonnegative(),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }),
    environment: z.string().max(32).optional(),
    release: z.string().max(64).optional(),
    error_event_ids: z.array(z.string().min(1).max(64)).default([]),
    sdk: z.object({ name: z.string().min(1).max(64), version: z.string().max(32) }),
    events: z.array(ReplayEventSchema).max(10_000),
  })
  .refine((s) => Date.parse(s.ended_at) >= Date.parse(s.started_at), {
    message: "ended_at must not be before started_at",
    path: ["ended_at"],
  });

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The example payload from CONTRACT.md, verbatim. */
export const CONTRACT_EXAMPLE = {
  replay_id: "5d0a6d1c-7a33-4c2f-9b53-0f6a1d8b6d11",
  segment: 0,
  started_at: "2026-11-02T16:00:00.000Z",
  ended_at: "2026-11-02T16:00:30.000Z",
  environment: "production",
  release: "1.2.3",
  error_event_ids: ["0123456789abcdef0123456789abcdef"],
  sdk: { name: "codmir.javascript", version: "2.1.0" },
  events: [{ type: 2, data: {}, timestamp: 1793635200000 }],
};
