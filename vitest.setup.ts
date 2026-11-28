import { beforeEach } from "vitest";

// The release and environment defaults read the host (see src/overseer/detect.ts). A CI runner sets some of them
// (GitHub Actions sets GITHUB_SHA), so clear them before each test file: a test sees one only when it stubs it.
// NODE_ENV stays as vitest sets it.
const HOST_VARS = [
  "CODMIR_RELEASE",
  "VERCEL_GIT_COMMIT_SHA",
  "RAILWAY_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "SOURCE_VERSION",
  "CF_PAGES_COMMIT_SHA",
  "COMMIT_REF",
  "GITHUB_SHA",
  "CODMIR_ENVIRONMENT",
  "VERCEL_ENV",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_ENV",
];

for (const name of HOST_VARS) delete process.env[name];

// The replay session lives in `sessionStorage`, which a jsdom file keeps from one test to the next: each test starts as
// a new tab, and a test that wants a stored session writes it.
beforeEach(() => {
  if (typeof window !== "undefined") window.sessionStorage.clear();
});
