## Unreleased

### Features

* **overseer:** `captureException` sends where the error happened (CSL-5636): `contexts.browser`/`os`/`device` in a browser (from `navigator.userAgentData`, else a userAgent parse), `contexts.runtime`/`os` in Node, and in a browser `request.url` as origin and path only (never the query, hash, headers, cookies or body). In Node the first three in-app frames carry `pre_context`/`context_line`/`post_context` (5 lines each side, 240 characters per line, files over 1 MB skipped; turn off with `includeSourceContext: false`). Needs Node 20.16 or 22.3+ for ES modules (`process.getBuiltinModule`) to read the OS release and source files; CommonJS works on any supported Node.

### Bug Fixes

* **overseer:** stack traces parse V8 frames without a function, `async` and `new` frames, eval and native frames, and Firefox and Safari `fn@file:line:col` frames; `in_app` is false for `node_modules`, Node internals and the SDK's own files (CSL-5636).

* **overseer:** errors now reach Codmir (CSL-5492). Each error is sent as the `{type:"error", event, group}` wrapper the server stores, with a fingerprint computed like the platform's, instead of a flat event that was dropped behind a 200. Failed sends (non-2xx, network) are retried with capped exponential backoff and a bounded queue, `droppedEvents` is logged in debug mode, a browser flushes with `keepalive` on `pagehide`/hidden, and the default endpoint is always `https://codmir.com/api/overseer` rather than the page's own origin.
* **ci:** run `npm test` (the overseer suite) before the build.

## [1.0.2](https://github.com/codmir-labs/sdk/compare/v1.0.1...v1.0.2) (2026-05-10)


### Bug Fixes

* simplify CI — remove broken test/lint steps, keep build + release ([7bafb0b](https://github.com/codmir-labs/sdk/commit/7bafb0b2fdfff5d5909716823abc677c978f2feb))
