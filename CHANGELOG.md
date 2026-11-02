## Unreleased

### Bug Fixes

* **overseer:** errors now reach Codmir (CSL-5492). Each error is sent as the `{type:"error", event, group}` wrapper the server stores, with a fingerprint computed like the platform's, instead of a flat event that was dropped behind a 200. Failed sends (non-2xx, network) are retried with capped exponential backoff and a bounded queue, `droppedEvents` is logged in debug mode, a browser flushes with `keepalive` on `pagehide`/hidden, and the default endpoint is always `https://codmir.com/api/overseer` rather than the page's own origin.
* **ci:** run `npm test` (the overseer suite) before the build.

## [1.0.2](https://github.com/codmir-labs/sdk/compare/v1.0.1...v1.0.2) (2026-05-10)


### Bug Fixes

* simplify CI — remove broken test/lint steps, keep build + release ([7bafb0b](https://github.com/codmir-labs/sdk/commit/7bafb0b2fdfff5d5909716823abc677c978f2feb))
