import { z } from "zod";

// Copied from platform-v2 packages/types/src/api/overseer-replay.ts (CSL-5611, merged in platform-v2 7ad8cc79e, origin/development):
// `ReplaySegmentUploadSchema`, `ReplayUploadResponseSchema`. Keep in sync by hand.
const ReplayEventSchema = z.object({ type: z.number(), timestamp: z.number() }).passthrough();

export const ReplaySegmentUploadSchema = z.object({
  replay_id: z.string().uuid(),
  segment: z.number().int().min(0).max(1_000_000),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  environment: z.string().max(200).optional(),
  release: z.string().max(200).optional(),
  error_event_ids: z.array(z.string().min(1).max(64)).max(500).default([]),
  sdk: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(50) }),
  events: z.array(ReplayEventSchema).max(10_000),
});

export const ReplayUploadResponseSchema = z.object({
  stored: z.boolean(),
  reason: z.enum(["payment_required", "insufficient_credits"]).optional(),
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
