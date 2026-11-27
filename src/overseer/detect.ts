/**
 * What the host says about the deployed commit and the environment, for an app that sets neither. Every variable is
 * read on its own as a literal `process.env.NAME` inside an arrow, so a bundler that inlines one (Vite and webpack
 * inline `process.env.NODE_ENV`) still inlines it. Where `process` does not exist (a browser, a worker, React Native)
 * each read that was not inlined throws a ReferenceError that costs only that read.
 */

/** One read, isolated: a missing `process` or a throwing getter gives an empty string and nothing else is lost. */
function readEnv(read: () => unknown): string {
  try {
    return clean(read());
  } catch {
    return "";
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function first(...reads: Array<() => unknown>): string {
  for (const read of reads) {
    const text = readEnv(read);
    if (text) return text;
  }
  return "";
}

/** The release the host names: the SDK's own override, then the platforms' commit variables. Empty when none is set. */
export function detectRelease(): string {
  return first(
    () => process.env.CODMIR_RELEASE,
    () => process.env.VERCEL_GIT_COMMIT_SHA,
    () => process.env.RAILWAY_GIT_COMMIT_SHA,
    () => process.env.RENDER_GIT_COMMIT,
    () => process.env.SOURCE_VERSION,
    () => process.env.CF_PAGES_COMMIT_SHA,
    () => process.env.COMMIT_REF,
    () => process.env.GITHUB_SHA,
  );
}

/** The environment the host names: the SDK's own override, then Vercel's, then `NODE_ENV`. Empty when none is set. */
export function detectEnvironment(): string {
  return first(
    () => process.env.CODMIR_ENVIRONMENT,
    () => process.env.VERCEL_ENV,
    () => process.env.NODE_ENV,
  );
}

/** What Vercel exposes to a Next.js client bundle: the commit and the environment, empty when not inlined. */
export function detectNextClientHost(): { release: string; environment: string } {
  return {
    release: readEnv(() => process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA),
    environment: readEnv(() => process.env.NEXT_PUBLIC_VERCEL_ENV),
  };
}
