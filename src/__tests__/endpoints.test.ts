/** The SDK's endpoints come from one module: their URLs are unchanged, and only they are the SDK's own requests. */
import { describe, expect, it } from "vitest";
import { ENDPOINT_PATHS, feedbackUrl, ingestUrl, patchesManifestUrl, replayUrl } from "../endpoints";
import { isSdkRequest } from "../tracing/url-match";

/** One builder per endpoint path; a path added to `ENDPOINT_PATHS` without a row here fails the type check. */
const BUILDERS: Record<keyof typeof ENDPOINT_PATHS, Array<(dsn: string) => string>> = {
  ingest: [ingestUrl],
  replay: [replayUrl],
  feedback: [(d) => feedbackUrl(d), (d) => feedbackUrl(d, "fb_1"), (d) => feedbackUrl(d, "fb_1", "/answer"), (d) => feedbackUrl(d, "a b/c", "/status")],
  patchesManifest: [patchesManifestUrl],
};
const ALL = Object.values(BUILDERS).flat();

const DSNS = [
  "https://app.example.com",
  "https://app.example.com/",
  "https://www.example.com/api/v1/overseer",
  "https://www.example.com/api/v1/overseer/ingest",
  "https://www.example.com/api/v1/overseer/ingest/",
  "https://www.example.com/api/v1/overseer/",
  "https://www.example.com/api/v1/overseer//",
];

describe("the URLs, byte for byte", () => {
  it("a DSN", () => {
    const d = "https://www.example.com/api/v1/overseer";
    expect(ingestUrl(d)).toBe(`${d}/ingest`);
    expect(replayUrl(d)).toBe(`${d}/replay`);
    expect(feedbackUrl(d)).toBe(`${d}/feedback`);
    expect(feedbackUrl(d, "fb 1/x", "/answer")).toBe(`${d}/feedback/fb%201%2Fx/answer`);
    expect(patchesManifestUrl(d)).toBe(`${d}/patches/manifest`);
  });

  it("a DSN that ends in /ingest", () => {
    const d = "https://www.example.com/api/v1/overseer";
    expect(ingestUrl(`${d}/ingest`)).toBe(`${d}/ingest`);
    expect(replayUrl(`${d}/ingest`)).toBe(`${d}/replay`);
    expect(feedbackUrl(`${d}/ingest`, "fb_1")).toBe(`${d}/feedback/fb_1`);
    expect(patchesManifestUrl(`${d}/ingest`)).toBe(`${d}/patches/manifest`);
  });

  it("a root DSN", () => {
    expect(ingestUrl("https://app.example.com")).toBe("https://app.example.com/ingest");
    expect(replayUrl("https://app.example.com/")).toBe("https://app.example.com/replay");
    expect(feedbackUrl("https://app.example.com/")).toBe("https://app.example.com/feedback");
  });
});

describe("a trailing slash changes nothing", () => {
  const BASE = "https://www.example.com/api/v1/overseer";
  const FORMS = [BASE, `${BASE}/`, `${BASE}//`, `${BASE}/ingest`, `${BASE}/ingest/`];
  const EXPECTED = {
    ingest: [`${BASE}/ingest`],
    replay: [`${BASE}/replay`],
    feedback: [`${BASE}/feedback`, `${BASE}/feedback/fb_1`, `${BASE}/feedback/fb_1/answer`, `${BASE}/feedback/a%20b%2Fc/status`],
    patchesManifest: [`${BASE}/patches/manifest`],
  } satisfies Record<keyof typeof ENDPOINT_PATHS, string[]>;

  for (const dsn of FORMS) {
    it(`every builder returns the single-slash URL for ${dsn}`, () => {
      for (const key of Object.keys(BUILDERS) as Array<keyof typeof BUILDERS>) {
        expect(BUILDERS[key].map((build) => build(dsn)), key).toEqual(EXPECTED[key]);
      }
    });
  }

  it("a root DSN with one or two slashes", () => {
    for (const dsn of ["https://x.test", "https://x.test/", "https://x.test//"]) {
      expect(ingestUrl(dsn)).toBe("https://x.test/ingest");
      expect(replayUrl(dsn)).toBe("https://x.test/replay");
      expect(patchesManifestUrl(dsn)).toBe("https://x.test/patches/manifest");
    }
  });

  it("isSdkRequest matches what is sent for a DSN with a trailing slash", () => {
    for (const dsn of [`${BASE}/`, `${BASE}//`, `${BASE}/ingest/`]) {
      for (const path of ["/ingest", "/replay", "/feedback", "/feedback/fb_1", "/patches/manifest"]) {
        expect(isSdkRequest(new URL(`https://www.example.com/api/v1/overseer${path}`), dsn), `${dsn} ${path}`).toBe(true);
      }
      expect(isSdkRequest(new URL("https://www.example.com/api/v1/overseer/issues"), dsn)).toBe(false);
    }
  });
});

describe("isSdkRequest", () => {
  for (const dsn of DSNS) {
    it(`is true for every endpoint of ${dsn}, with or without a query`, () => {
      for (const build of ALL) {
        expect(isSdkRequest(new URL(build(dsn)), dsn), build(dsn)).toBe(true);
        expect(isSdkRequest(new URL(`${build(dsn)}?x=1`), dsn)).toBe(true);
      }
    });

  }

  for (const dsn of DSNS.filter((d) => !d.endsWith("/"))) {
    it(`is true for every endpoint of ${dsn} given its ingest URL as the DSN`, () => {
      for (const build of ALL) expect(isSdkRequest(new URL(build(dsn)), ingestUrl(dsn))).toBe(true);
    });
  }

  it("is false for the rest of the origin, at the root and under a DSN path", () => {
    expect(isSdkRequest(new URL("https://app.example.com/api/cart"), "https://app.example.com")).toBe(false);
    expect(isSdkRequest(new URL("https://app.example.com/"), "https://app.example.com")).toBe(false);
    const dsn = "https://www.example.com/api/v1/overseer";
    for (const path of ["/api/v1/overseer/issues?project=x", "/api/v1/overseer", "/api/v1/overseer/", "/api/v1/overseer/ingestion", "/api/v1/overseer/replay/x", "/api/v1/overseer/feedbacks", "/api/v1/overseer/sub/ingest", "/ingest", "/replay", "/feedback"]) {
      expect(isSdkRequest(new URL(`https://www.example.com${path}`), dsn), path).toBe(false);
    }
  });

  it("is false for another origin, scheme or port", () => {
    const dsn = "https://www.example.com/api/v1/overseer";
    for (const origin of ["https://example.com", "http://www.example.com", "https://www.example.com:8443", "https://www.example.com.evil.test"]) {
      expect(isSdkRequest(new URL(`${origin}/api/v1/overseer/ingest`), dsn)).toBe(false);
    }
  });
});
