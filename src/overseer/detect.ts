/**
 * What the host says about the deployed commit and the environment, for an app that sets neither. Every variable is
 * read as a literal `process.env.NAME`, so a bundler that inlines `process.env.NODE_ENV` still inlines it, and where
 * `process` does not exist (a browser, a worker, React Native) nothing is read and nothing throws.
 */

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

/** The release the host names: the SDK's own override, then the platforms' commit variables. Empty when none is set. */
export function detectRelease(): string {
  if (typeof process === "undefined" || !process.env) return "";
  try {
    return first(
      process.env.CODMIR_RELEASE,
      process.env.VERCEL_GIT_COMMIT_SHA,
      process.env.RAILWAY_GIT_COMMIT_SHA,
      process.env.RENDER_GIT_COMMIT,
      process.env.SOURCE_VERSION,
      process.env.CF_PAGES_COMMIT_SHA,
      process.env.COMMIT_REF,
      process.env.GITHUB_SHA,
    );
  } catch {
    return "";
  }
}

/** The environment the host names: the SDK's own override, then Vercel's, then `NODE_ENV`. Empty when none is set. */
export function detectEnvironment(): string {
  if (typeof process === "undefined" || !process.env) return "";
  try {
    return first(process.env.CODMIR_ENVIRONMENT, process.env.VERCEL_ENV, process.env.NODE_ENV);
  } catch {
    return "";
  }
}
