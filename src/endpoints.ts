/**
 * The URLs the SDK itself calls, built from a DSN in one place. Request instrumentation and `@codmir/sdk/feedback`
 * recognise the SDK's own requests from the same builders, so a new endpoint added here is skipped there too.
 * Browser-safe, imports nothing. `dsn` is the DSN or the ingest URL (the DSN with a trailing `/ingest`).
 */

/** The endpoint paths under `<base>`, `<base>` being the DSN without a trailing `/ingest`. */
export const ENDPOINT_PATHS = {
  ingest: "/ingest",
  replay: "/replay",
  feedback: "/feedback",
  patchesManifest: "/patches/manifest",
} as const;

/** `<base>`: the DSN without a trailing `/ingest` and trailing slashes, so `…/a`, `…/a/` and `…/a/ingest/` share one base. */
export const baseOf = (dsn: string): string => dsn.replace(/(\/ingest)?\/*$/, "");

/** `<base>/ingest`. */
export function ingestUrl(dsn: string): string {
  return `${baseOf(dsn)}${ENDPOINT_PATHS.ingest}`;
}

/** `<base>/replay`. */
export function replayUrl(dsn: string): string {
  return `${baseOf(dsn)}${ENDPOINT_PATHS.replay}`;
}

/** `<base>/feedback`, or `<base>/feedback/<id><suffix>` for one piece of feedback. */
export function feedbackUrl(dsn: string, id?: string, suffix = ""): string {
  const root = `${baseOf(dsn)}${ENDPOINT_PATHS.feedback}`;
  return id === undefined ? root : `${root}/${encodeURIComponent(id)}${suffix}`;
}

/** `<base>/patches/manifest`. */
export function patchesManifestUrl(dsn: string): string {
  return `${baseOf(dsn)}${ENDPOINT_PATHS.patchesManifest}`;
}
