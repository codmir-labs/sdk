/** The SDK's own name and version, as reported in every event's `sdk` field. */

/** Injected from package.json's `version` by tsup (`tsup.config.ts`) and vitest (`vitest.config.ts`). */
declare const __SDK_VERSION__: string | undefined;

/** Reported when nothing injected the version, e.g. source loaded by a tool that bypasses the build. */
export const FALLBACK_SDK_VERSION = "0.0.0-unknown";

export const SDK_NAME = "@codmir/sdk";
export const SDK_VERSION: string = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : FALLBACK_SDK_VERSION;

export const SDK_INFO = { name: SDK_NAME, version: SDK_VERSION } as const;
